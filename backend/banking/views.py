
import json
import re
import random
import threading
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import Account, Transfer, TransferEvent, Incident
from .serializers import (
    AccountSerializer,
    TransferSerializer,
    TransferEventSerializer,
    IncidentSerializer,
)

User = get_user_model()

OLLAMA_BASE_URL = getattr(
    settings, "OLLAMA_BASE_URL", "http://127.0.0.1:11434"
)
OLLAMA_MODEL = getattr(settings, "OLLAMA_MODEL", "llama3.2:3b")

FAULTS = {
    "delayed_credit": {
        "label": "Delayed receiver credit",
        "severity": "HIGH",
        "description": "The sender was debited before the receiver was credited.",
        "hypothesis": "The receiver-credit processing step was delayed in the simulator.",
    },
    "stale_balance": {
        "label": "Stale balance display",
        "severity": "MEDIUM",
        "description": "The predefined scenario represents a stale balance display.",
        "hypothesis": "A stale read or delayed cache refresh is a candidate cause; cache telemetry is needed to verify it.",
    },
    "network_timeout": {
        "label": "Network timeout",
        "severity": "HIGH",
        "description": "The predefined scenario represents a request/response timeout.",
        "hypothesis": "A network timeout is a candidate cause; actual network telemetry is needed to verify it.",
    },
    "database_failure": {
        "label": "Database connection failure",
        "severity": "CRITICAL",
        "description": "The predefined scenario represents a database connection failure.",
        "hypothesis": "A database connection interruption is a candidate cause; database logs are needed to verify it.",
    },
    "duplicate_request": {
        "label": "Duplicate transaction request",
        "severity": "MEDIUM",
        "description": "The predefined scenario represents a duplicate transaction request.",
        "hypothesis": "A repeated submission is a candidate cause; request IDs and idempotency records are needed to verify it.",
    },
    "service_crash": {
        "label": "Payment service interruption",
        "severity": "HIGH",
        "description": "The predefined scenario represents a payment-worker interruption.",
        "hypothesis": "A worker interruption is a candidate cause; runtime and worker logs are needed to verify it.",
    },
    "queue_backlog": {
        "label": "Confirmation queue backlog",
        "severity": "HIGH",
        "description": "The predefined scenario represents a confirmation queue backlog.",
        "hypothesis": "Consumer lag is a candidate cause; queue-depth and consumer-lag metrics are needed to verify it.",
    },
    "bad_config": {
        "label": "Invalid service configuration",
        "severity": "HIGH",
        "description": "The predefined scenario represents an invalid service configuration.",
        "hypothesis": "A configuration issue is a candidate cause; configuration history is needed to verify it.",
    },
}


def is_admin(user):
    return user.is_staff or user.groups.filter(name="RootLens Admin").exists()


def add_transfer_event(transfer, event_type, details=None, occurred_at=None):
    """Persist an event using the actual time this simulator records it."""
    return TransferEvent.objects.create(
        transfer=transfer,
        event_type=event_type,
        occurred_at=occurred_at or timezone.now(),
        details=details or {},
    )


def recover_incident_safely(incident_id):
    """
    Recover an incident once.

    The incident and transfer are locked inside one database transaction.
    Receiver credit and its event are committed together.
    """
    close_old_connections()
    try:
        with transaction.atomic():
            incident = (
                Incident.objects.select_for_update()
                .select_related("transfer")
                .filter(pk=incident_id)
                .first()
            )

            if not incident or incident.status not in ("ACTIVE", "INVESTIGATING"):
                return

            transfer_obj = incident.transfer

            if transfer_obj and transfer_obj.status == "PENDING":
                transfer_obj = Transfer.objects.select_for_update().get(
                    pk=transfer_obj.pk
                )

                if transfer_obj.status == "PENDING":
                    add_transfer_event(
                        transfer_obj,
                        "RECOVERY_STARTED",
                        {"source": "simulator_recovery"},
                    )

                    receiver_account = Account.objects.select_for_update().get(
                        user=transfer_obj.receiver
                    )

                    receiver_account.balance += transfer_obj.amount
                    receiver_account.save(update_fields=["balance"])

                    credited_at = timezone.now()
                    transfer_obj.receiver_credited_at = credited_at
                    transfer_obj.completed_at = credited_at
                    transfer_obj.status = "COMPLETED"
                    transfer_obj.save(
                        update_fields=[
                            "receiver_credited_at",
                            "completed_at",
                            "status",
                        ]
                    )

                    add_transfer_event(
                        transfer_obj,
                        "RECEIVER_CREDITED",
                        {"source": "simulator_recovery"},
                        occurred_at=credited_at,
                    )
                    add_transfer_event(
                        transfer_obj,
                        "TRANSFER_COMPLETED",
                        {"source": "simulator_recovery"},
                        occurred_at=credited_at,
                    )
                    add_transfer_event(
                        transfer_obj,
                        "RECOVERY_COMPLETED",
                        {"source": "simulator_recovery"},
                        occurred_at=credited_at,
                    )

            incident.status = "RECOVERED"
            incident.recovered_at = timezone.now()
            incident.save(update_fields=["status", "recovered_at"])

            if transfer_obj:
                incident.evidence = build_transfer_evidence(transfer_obj)
                incident.save(update_fields=["evidence"])
    finally:
        close_old_connections()


def build_transfer_evidence(transfer_obj):
    """Build evidence only from persisted simulator events and transfer fields."""
    evidence = []

    for event in transfer_obj.events.all():
        evidence.append({
            "event_id": event.id,
            "time": event.occurred_at.isoformat(),
            "kind": event.event_type.lower(),
            "service": "paynova-simulator",
            "message": event.get_event_type_display(),
            "level": "INFO",
            "details": event.details,
            "source": "recorded_simulator_event",
        })

    if transfer_obj.sender_debited_at and transfer_obj.receiver_credited_at:
        delay_ms = max(
            0,
            round(
                (
                    transfer_obj.receiver_credited_at
                    - transfer_obj.sender_debited_at
                ).total_seconds() * 1000,
            ),
        )
        evidence.append({
            "time": transfer_obj.receiver_credited_at.isoformat(),
            "kind": "measured_delay",
            "service": "paynova-simulator",
            "message": f"Recorded sender-debit to receiver-credit interval: {delay_ms} ms.",
            "level": "INFO",
            "delay_ms": delay_ms,
            "source": "calculated_from_recorded_timestamps",
        })

    return evidence


def ollama_chat(messages, timeout=90):
    """Call the local Ollama chat API; raise a useful error if unavailable."""
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.1},
    }).encode("utf-8")

    request = Request(
        f"{OLLAMA_BASE_URL.rstrip('/')}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data.get("message", {}).get("content", "").strip()
    except HTTPError as exc:
        raise RuntimeError(f"Ollama returned HTTP {exc.code}.") from exc
    except URLError as exc:
        raise RuntimeError(
            "Cannot connect to Ollama. Ensure Ollama is running locally."
        ) from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError("Ollama timed out or returned invalid JSON.") from exc


def build_root_cause_analysis(incident):
    """
    Rank candidates using explicit deterministic rules.
    Scores are evidence-match scores, not statistical probabilities.
    """
    transfer_obj = incident.transfer
    evidence = list(incident.evidence or [])
    events = []

    if transfer_obj:
        events = list(transfer_obj.events.all())
        evidence = build_transfer_evidence(transfer_obj)

    candidates = []

    def matching_record_count(records, patterns):
        """Count distinct recorded items that match any candidate-specific signal."""
        count = 0
        for record in records:
            if isinstance(record, dict):
                text = " ".join(
                    str(record.get(field, ""))
                    for field in (
                        "kind", "message", "service", "source", "details",
                        "signals", "fault_type", "event_type",
                    )
                ).lower()
            else:
                text = str(record).lower()
            if text and any(pattern in text for pattern in patterns):
                count += 1
        return count

    def add_candidate(
        name, score, supporting, missing, solution, verify,
        supporting_count=0, missing_count=None,
    ):
        # These numeric fields are for graphs. Narrative explanations above
        # are intentionally not counted as evidence records.
        if missing_count is None:
            missing_count = max(
                0,
                sum(
                    1 for item in missing
                    if "independent corroboration" not in str(item).lower()
                    and "independent service telemetry" not in str(item).lower()
                ),
            )
        candidates.append({
            "cause": name,
            "score": max(0, min(100, int(score))),
            "supporting_evidence": supporting,
            "missing_evidence": missing,
            "supporting_evidence_count": max(0, int(supporting_count)),
            "missing_evidence_count": max(0, int(missing_count)),
            "solution": solution,
            "verification": verify,
        })

    def evidence_items_for_primary(incident_obj, transfer):
        """Use the same actual incident + persisted transfer records for primary matching."""
        items = list(incident_obj.evidence or [])
        if transfer:
            items.extend(build_transfer_evidence(transfer))
        return items

    fault_type = incident.fault_type

    cause_catalog = {
        "delayed_credit": (
            "Receiver-credit processing delay",
            "Inspect the receiver-credit worker, retry handling, and processing queue.",
            "Compare recorded sender-debit and receiver-credit timestamps.",
        ),
        "stale_balance": (
            "Stale balance or cache refresh",
            "Check cache invalidation, read-after-write behavior, and freshness limits.",
            "Compare the ledger balance with the displayed balance and cache timestamps.",
        ),
        "network_timeout": (
            "Network timeout or retry handling",
            "Inspect request duration, timeout configuration, and retry logs.",
            "Correlate request IDs with recorded network telemetry and retry outcomes.",
        ),
        "database_failure": (
            "Database connectivity or transaction failure",
            "Inspect connection pool health, database availability, and transaction errors.",
            "Review database logs and connection metrics for the incident interval.",
        ),
        "duplicate_request": (
            "Duplicate request or idempotency handling",
            "Enforce a unique idempotency key and return the original result for retries.",
            "Compare request IDs, idempotency keys, and ledger entries.",
        ),
        "service_crash": (
            "Payment worker interruption",
            "Inspect worker health, restart events, and task acknowledgement behavior.",
            "Correlate worker lifecycle records with the transfer timeline.",
        ),
        "queue_backlog": (
            "Confirmation queue backlog",
            "Inspect queue depth, consumer lag, retry counts, and worker capacity.",
            "Compare queue metrics and consumer processing times for the event interval.",
        ),
        "bad_config": (
            "Service configuration regression",
            "Review configuration revisions and roll back a confirmed problematic change.",
            "Correlate configuration history with measured latency and error rates.",
        ),
    }

    target = cause_catalog.get(fault_type)
    if target:
        # The selected simulator fault type identifies the scenario being
        # modeled, but it is not independent proof of the underlying cause.
        supporting = [
            f"The simulator selected the '{fault_type}' scenario for this incident.",
        ]
        score = 60

        # Score the primary hypothesis higher only when the stored evidence
        # contains a signal specific to that fault. Ordinary debit/credit
        # timestamps are useful timeline context, but do not prove a queue,
        # network, database, cache, or worker failure.
        primary_signal_patterns = {
            "delayed_credit": (
                "receiver_credit_delayed", "credit delayed", "credit pending",
                "receiver credit failed", "credit processing delay",
            ),
            "stale_balance": (
                "stale_cache_value", "balance_refresh_required", "stale balance",
                "outdated balance", "cache invalidation failed",
            ),
            "network_timeout": (
                "simulated_request_timeout", "timed out", "timeout exceeded",
                "deadline exceeded", "connection timeout",
            ),
            "database_failure": (
                "simulated_database_connection_failure", "database unavailable",
                "database error", "transaction rollback", "connection refused",
            ),
            "duplicate_request": (
                "simulated_duplicate_request", "duplicate request",
                "duplicate transaction", "idempotency conflict",
            ),
            "service_crash": (
                "simulated_worker_interruption", "worker crashed", "service crashed",
                "process terminated", "uncaught exception",
            ),
            "queue_backlog": (
                "simulated_queue_backlog", "queue backlog", "consumer lag",
                "queue depth exceeded", "messages pending",
            ),
            "bad_config": (
                "simulated_invalid_configuration", "invalid configuration",
                "configuration error", "missing environment variable",
            ),
        }
        stored_evidence_text = " ".join(
            str(item.get(field, ""))
            for item in (incident.evidence or [])
            if isinstance(item, dict)
            for field in ("kind", "message", "service", "source", "details", "signals", "fault_type")
        ).lower()
        primary_matches = [
            pattern for pattern in primary_signal_patterns.get(fault_type, ())
            if pattern in stored_evidence_text
        ]
        if primary_matches:
            supporting.append(
                "Candidate-specific signal found in stored incident evidence: "
                + ", ".join(primary_matches) + "."
            )
            score = 80
        else:
            supporting.append(
                "No independent fault-specific telemetry is stored for this scenario; "
                "the scenario label is not proof of a production root cause."
            )

        primary_matching_records = matching_record_count(
            evidence_items_for_primary(incident, transfer_obj),
            primary_signal_patterns.get(fault_type, ()),
        )
        add_candidate(
            target[0],
            score,
            supporting,
            [
                target[2],
                "Independent service telemetry is not available in this simulator.",
            ],
            target[1],
            target[2],
            supporting_count=primary_matching_records,
            missing_count=max(1, len([
                part for part in re.split(r",| and ", target[2].rstrip("."))
                if part.strip()
            ])),
        )

    # Alternative hypotheses are assessed against candidate-specific signals.
    # A missing signal is not proof that a fault did not occur; it means the
    # current incident records do not support that hypothesis independently.
    alternatives = [
        (
            "Network timeout or retry handling",
            "network_timeout",
            (
                "simulated_request_timeout", "timed out", "timeout exceeded",
                "deadline exceeded", "connection timeout", "retry exhausted",
            ),
            "request duration, timeout logs, retry history, and request IDs",
        ),
        (
            "Database connectivity or transaction failure",
            "database_failure",
            (
                "simulated_database_connection_failure", "database unavailable",
                "database error", "transaction rollback", "connection refused",
                "could not connect to database",
            ),
            "database connection logs, query errors, and transaction outcomes",
        ),
        (
            "Queue backlog or consumer lag",
            "queue_backlog",
            (
                "simulated_queue_backlog", "queue backlog", "consumer lag",
                "queue depth exceeded", "messages pending", "oldest message age",
            ),
            "queue depth, oldest-message age, and consumer processing metrics",
        ),
        (
            "Worker interruption",
            "service_crash",
            (
                "simulated_worker_interruption", "worker crashed",
                "service crashed", "process terminated", "uncaught exception",
                "worker restart",
            ),
            "worker health, process status, restart history, and task acknowledgements",
        ),
        (
            "Stale balance or cache refresh",
            "stale_balance",
            (
                "stale_cache_value", "balance_refresh_required", "stale balance",
                "outdated balance", "cache invalidation failed", "cache age",
            ),
            "cache value age, balance version, and refresh timestamps",
        ),
        (
            "Duplicate request or idempotency handling",
            "duplicate_request",
            (
                "simulated_duplicate_request", "duplicate request",
                "duplicate transaction", "idempotency conflict", "already processed",
                "same idempotency key",
            ),
            "request IDs, idempotency keys, and ledger-entry counts",
        ),
        (
            "Service configuration regression",
            "bad_config",
            (
                "simulated_invalid_configuration", "invalid configuration",
                "configuration error", "missing environment variable",
                "invalid service url", "configuration changed",
            ),
            "configuration validation, version history, and deployment records",
        ),
        (
            "Receiver-credit processing delay",
            "delayed_credit",
            (
                "receiver_credit_delayed", "credit delayed", "credit pending",
                "receiver credit failed", "credit processing delay",
            ),
            "receiver-credit worker logs, processing duration, and retry records",
        ),
    ]

    # Preserve both incident-level evidence (including explicit simulation
    # signals) and persisted transfer events. Do not claim simulation signals
    # are independent production telemetry.
    evidence_items = list(incident.evidence or [])
    if transfer_obj:
        evidence_items.extend(build_transfer_evidence(transfer_obj))

    evidence_text = []
    for item in evidence_items:
        if isinstance(item, dict):
            evidence_text.append(
                " ".join(
                    str(item.get(field, ""))
                    for field in (
                        "kind",
                        "message",
                        "service",
                        "source",
                        "details",
                        "signals",
                        "fault_type",
                        "event_type",
                    )
                ).lower()
            )

    combined_evidence = "\n".join(evidence_text)
    existing_names = {item["cause"] for item in candidates}

    for name, key, patterns, required_evidence in alternatives:
        catalog_item = cause_catalog[key]
        candidate_name = catalog_item[0]

        # Never add the selected primary fault again as a low-scoring
        # alternative. The display label in the alternatives list can differ
        # from the canonical catalog label, so compare the fault key too.
        if key == fault_type:
            continue
        if name in existing_names or candidate_name in existing_names:
            continue

        matched_signals = [
            pattern for pattern in patterns if pattern in combined_evidence
        ]

        if matched_signals:
            supporting = [
                "Matching recorded text/signal: "
                + ", ".join(matched_signals)
                + ".",
                "Check the source and origin of this signal; simulated evidence "
                "does not independently establish a production fault.",
            ]
            # A match modestly increases a heuristic ranking score; it is not
            # a calibrated probability.
            score = 35
        else:
            supporting = [
                f"No {key.replace('_', ' ')}-specific signal was found "
                "in the available incident records.",
                "Recorded transfer events provide context but do not by "
                "themselves confirm this failure mode.",
            ]
            score = 15

        matched_record_count = matching_record_count(evidence_items, patterns)
        add_candidate(
            candidate_name,
            score,
            supporting,
            [
                f"Required to investigate this candidate: {required_evidence}.",
                "Independent corroboration is needed before confirmation.",
            ],
            catalog_item[1],
            catalog_item[2],
            supporting_count=matched_record_count,
            missing_count=max(1, len([
                part for part in re.split(r",| and ", required_evidence.rstrip("."))
                if part.strip()
            ])),
        )

    # Preserve raw heuristic scores separately from the visual ranking-share
    # allocation. The leading candidate receives 60 share points; the remaining
    # 40 are distributed across alternatives in proportion to their raw scores.
    # These shares are a display allocation, NOT calibrated probabilities.
    candidates.sort(key=lambda item: item["score"], reverse=True)
    for item in candidates:
        item["evidence_match_score"] = item["score"]

    if candidates:
        candidates[0]["ranking_share"] = 60.0
        alternatives_only = candidates[1:]
        if alternatives_only:
            raw_total = sum(max(0, int(item.get("evidence_match_score", 0))) for item in alternatives_only)
            remaining = 40.0
            if raw_total > 0:
                shares = [
                    remaining * max(0, int(item.get("evidence_match_score", 0))) / raw_total
                    for item in alternatives_only
                ]
            else:
                shares = [remaining / len(alternatives_only)] * len(alternatives_only)
            # Round to one decimal place and allocate rounding remainder to last row.
            rounded = [round(value, 1) for value in shares]
            if rounded:
                rounded[-1] = round(remaining - sum(rounded[:-1]), 1)
            for item, share in zip(alternatives_only, rounded):
                item["ranking_share"] = share
    primary = candidates[0] if candidates else None

    return {
        "incident_key": incident.incident_key,
        "score_type": "relative_ranking_share",
        "score_warning": (
            "Ranking shares are a display allocation: the leading candidate receives 60 "
            "share points and the remaining 40 are distributed across alternatives based "
            "on their raw heuristic scores. They are not calibrated probabilities and "
            "do not prove a production root cause. Raw evidence_match_score is also returned."
        ),
        "primary_cause": primary,
        "tree": {
            "label": "Incident root-cause candidates",
            "children": candidates,
        },
        "evidence": evidence,
        "timeline": TransferSerializer(transfer_obj).data if transfer_obj else None,
        "generated_at": timezone.now().isoformat(),
    }


class HealthView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({
            "status": "ok",
            "app": "PayNova demo payments with RootLens AI incident monitoring",
            "ollama_model": OLLAMA_MODEL,
        })


class LoginView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = str(request.data.get("username", "")).strip()
        password = str(request.data.get("password", ""))
        user = authenticate(request, username=username, password=password)

        if not user:
            return Response(
                {"detail": "Invalid username or password."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        refresh = RefreshToken.for_user(user)
        return Response({
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": {
                "username": user.username,
                "role": "admin" if is_admin(user) else "user",
            },
        })


class MeView(APIView):
    def get(self, request):
        account, _ = Account.objects.get_or_create(
            user=request.user,
            defaults={"account_number": f"RL{request.user.id:08d}"},
        )
        return Response({
            "username": request.user.username,
            "role": "admin" if is_admin(request.user) else "user",
            "account": AccountSerializer(account).data,
        })


class DashboardView(APIView):
    def get(self, request):
        user = request.user

        if is_admin(user):
            incidents = Incident.objects.select_related(
                "affected_user", "transfer"
            ).all()[:20]
            transfers = Transfer.objects.select_related(
                "sender", "receiver"
            ).prefetch_related("events").order_by("-created_at")
            accounts = Account.objects.select_related("user").all().order_by(
                "user__username"
            )

            return Response({
                "role": "admin",
                "incidents": IncidentSerializer(incidents, many=True).data,
                "transfers": TransferSerializer(transfers, many=True).data,
                "accounts": AccountSerializer(accounts, many=True).data,
                "stats": {
                    "total_incidents": Incident.objects.count(),
                    "active_incidents": Incident.objects.filter(
                        status="ACTIVE"
                    ).count(),
                    "recovered_incidents": Incident.objects.filter(
                        status="RECOVERED"
                    ).count(),
                    "total_transfers": Transfer.objects.count(),
                },
            })

        account, _ = Account.objects.get_or_create(
            user=user,
            defaults={"account_number": f"RL{user.id:08d}"},
        )
        transfers = Transfer.objects.filter(
            Q(sender=user) | Q(receiver=user)
        ).select_related("sender", "receiver").prefetch_related("events").order_by(
            "-created_at"
        )[:20]
        recipients = Account.objects.select_related("user").exclude(
            user=user
        ).order_by("user__username")

        return Response({
            "role": "user",
            "account": AccountSerializer(account).data,
            "transfers": TransferSerializer(transfers, many=True).data,
            "recipients": AccountSerializer(recipients, many=True).data,
        })


class TransferView(APIView):
    @transaction.atomic
    def post(self, request):
        if is_admin(request.user):
            return Response(
                {"detail": "Admin accounts cannot send demo transfers."},
                status=403,
            )

        receiver_name = str(request.data.get("receiver", "")).strip()
        try:
            amount = Decimal(
                str(request.data.get("amount", "0"))
            ).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError):
            return Response({"detail": "Enter a valid amount."}, status=400)

        if amount <= 0:
            return Response({"detail": "Amount must be greater than zero."}, status=400)
        if amount > Decimal("100000"):
            return Response({"detail": "Demo transfer limit is ₹100,000."}, status=400)

        try:
            if receiver_name.startswith("+91"):
                account_match = next(
                    (
                        account
                        for account in Account.objects.select_related("user").all()
                        if AccountSerializer(account).data.get("phone_number") == receiver_name
                    ),
                    None,
                )
                receiver = account_match.user if account_match else None
                if receiver is None:
                    raise User.DoesNotExist
            else:
                receiver = User.objects.get(username=receiver_name)
        except User.DoesNotExist:
            return Response(
                {"detail": "Receiver not found. Choose a registered demo member."},
                status=404,
            )

        if receiver.id == request.user.id:
            return Response({"detail": "You cannot send money to yourself."}, status=400)

        sender_account = Account.objects.select_for_update().filter(
            user=request.user
        ).first()
        receiver_account = Account.objects.select_for_update().filter(
            user=receiver
        ).first()

        if not sender_account or not receiver_account:
            return Response(
                {"detail": "Sender or receiver account is not initialized."},
                status=400,
            )
        if sender_account.balance < amount:
            return Response({"detail": "Insufficient demo balance."}, status=400)

        fault_type = random.choices(
            ["none", *FAULTS.keys()],
            weights=[55, 8, 7, 8, 5, 5, 5, 4, 3],
            k=1,
        )[0]

        request_at = timezone.now()
        txid = f"TX-{uuid.uuid4().hex[:10].upper()}"

        sender_account.balance -= amount
        sender_account.save(update_fields=["balance"])
        debit_at = timezone.now()

        transfer_obj = Transfer.objects.create(
            transaction_id=txid,
            sender=request.user,
            receiver=receiver,
            amount=amount,
            status="PENDING" if fault_type != "none" else "COMPLETED",
            fault_type=fault_type if fault_type != "none" else "",
            request_received_at=request_at,
            sender_debited_at=debit_at,
        )

        add_transfer_event(
            transfer_obj,
            "REQUEST_RECEIVED",
            {"sender": request.user.username, "receiver": receiver.username},
            occurred_at=request_at,
        )
        add_transfer_event(
            transfer_obj,
            "SENDER_DEBITED",
            {"amount": str(amount), "currency": "INR"},
            occurred_at=debit_at,
        )

        incident = None

        if fault_type == "none":
            receiver_account.balance += amount
            receiver_account.save(update_fields=["balance"])
            credit_at = timezone.now()

            transfer_obj.receiver_credited_at = credit_at
            transfer_obj.completed_at = credit_at
            transfer_obj.save(update_fields=["receiver_credited_at", "completed_at"])

            add_transfer_event(
                transfer_obj,
                "RECEIVER_CREDITED",
                {"amount": str(amount), "currency": "INR"},
                occurred_at=credit_at,
            )
            add_transfer_event(
                transfer_obj,
                "TRANSFER_COMPLETED",
                {"status": "COMPLETED"},
                occurred_at=credit_at,
            )
        else:
            info = FAULTS[fault_type]
            incident = Incident.objects.create(
                incident_key=f"INC-{uuid.uuid4().hex[:8].upper()}",
                title=info["label"],
                fault_type=fault_type,
                description=info["description"],
                severity=info["severity"],
                affected_user=request.user,
                transfer=transfer_obj,
                evidence=build_transfer_evidence(transfer_obj),
                hypothesis=info["hypothesis"],
            )

            timer = threading.Timer(
                3.0, recover_incident_safely, args=(incident.pk,)
            )
            timer.daemon = True
            timer.start()

        transfer_obj.refresh_from_db()
        if incident:
            incident.refresh_from_db()
            incident.evidence = build_transfer_evidence(transfer_obj)
            incident.save(update_fields=["evidence"])

        return Response({
            "message": (
                "Transfer completed in the simulator."
                if not incident
                else "A temporary simulated service issue was detected. Recovery is pending."
            ),
            "transfer": TransferSerializer(transfer_obj).data,
            "incident": IncidentSerializer(incident).data if incident else None,
            "recovered": bool(incident and incident.status == "RECOVERED"),
            "account": AccountSerializer(sender_account).data,
        }, status=201)



class SimulateFaultView(APIView):
    """
    Create a deterministic, explicitly simulated incident.

    Evidence describes the modeled scenario; it does not claim that a
    production failure was independently observed.
    """

    SCENARIO_EVIDENCE = {
        "delayed_credit": {
            "kind": "credit_delay_simulation",
            "service": "payment-simulator",
            "message": (
                "Simulated delayed receiver credit after sender debit."
            ),
            "signals": ["sender_debited", "receiver_credit_delayed"],
            "verification_needed": [
                "receiver_credit_timestamp",
                "configured_delay_threshold",
            ],
        },
        "stale_balance": {
            "kind": "cache_staleness_simulation",
            "service": "balance-cache-simulator",
            "message": (
                "Simulated stale balance response from a cached value."
            ),
            "signals": ["stale_cache_value", "balance_refresh_required"],
            "verification_needed": [
                "cache_value_age",
                "balance_version",
                "refresh_timestamp",
            ],
        },
        "network_timeout": {
            "kind": "network_timeout_simulation",
            "service": "network-simulator",
            "message": (
                "Simulated request/response timeout; no real network "
                "failure was performed."
            ),
            "signals": ["simulated_request_timeout"],
            "verification_needed": [
                "request_deadline",
                "timeout_timestamp",
                "retry_history",
            ],
        },
        "database_failure": {
            "kind": "database_failure_simulation",
            "service": "database-simulator",
            "message": (
                "Modeled a database connection failure; no real database "
                "connection was interrupted."
            ),
            "signals": ["simulated_database_connection_failure"],
            "verification_needed": [
                "database_connection_log",
                "query_error",
                "connection_recovery_timestamp",
            ],
        },
        "duplicate_request": {
            "kind": "duplicate_request_simulation",
            "service": "request-simulator",
            "message": (
                "Modeled a repeated request with the same idempotency key."
            ),
            "signals": ["simulated_duplicate_request"],
            "verification_needed": [
                "request_ids",
                "idempotency_key",
                "transaction_count",
            ],
        },
        "service_crash": {
            "kind": "service_interruption_simulation",
            "service": "payment-worker-simulator",
            "message": (
                "Modeled a payment-worker interruption; no real worker "
                "was terminated."
            ),
            "signals": ["simulated_worker_interruption"],
            "verification_needed": [
                "worker_process_status",
                "exception_trace",
                "restart_timestamp",
            ],
        },
        "queue_backlog": {
            "kind": "queue_backlog_simulation",
            "service": "confirmation-queue-simulator",
            "message": (
                "Modeled a confirmation queue backlog."
            ),
            "signals": ["simulated_queue_backlog"],
            "verification_needed": [
                "queue_depth",
                "oldest_message_age",
                "consumer_lag",
            ],
        },
        "bad_config": {
            "kind": "configuration_error_simulation",
            "service": "configuration-simulator",
            "message": (
                "Modeled an invalid service configuration; no live "
                "configuration was changed."
            ),
            "signals": ["simulated_invalid_configuration"],
            "verification_needed": [
                "configuration_validation_result",
                "configuration_version",
                "deployment_history",
            ],
        },
    }

    def post(self, request):
        if not is_admin(request.user):
            return Response(
                {
                    "detail": (
                        "Only admins can run standalone fault scenarios."
                    )
                },
                status=403,
            )

        fault_type = str(
            request.data.get("fault_type", "network_timeout")
        )

        if fault_type not in FAULTS:
            return Response(
                {"detail": "Unknown predefined fault."},
                status=400,
            )

        target_name = str(
            request.data.get("username", "demo_user")
        )
        target = User.objects.filter(
            username=target_name
        ).first()

        info = FAULTS[fault_type]
        scenario = self.SCENARIO_EVIDENCE[fault_type]
        now = timezone.now()

        evidence = {
            "time": now.isoformat(),
            "kind": scenario["kind"],
            "service": scenario["service"],
            "message": scenario["message"],
            "level": "WARN",
            "source": "rootlens_simulation",
            "evidence_origin": "simulated",
            "fault_type": fault_type,
            "signals": scenario["signals"],
            "verification_needed": scenario["verification_needed"],
        }

        incident = Incident.objects.create(
            incident_key=f"INC-{uuid.uuid4().hex[:8].upper()}",
            title=info["label"],
            fault_type=fault_type,
            description=info["description"],
            severity=info["severity"],
            affected_user=target,
            evidence=[evidence],
            hypothesis=info["hypothesis"],
            status="RECOVERED",
            recovered_at=now,
        )

        return Response(
            {
                "message": (
                    "Simulated scenario recorded. Evidence is labeled "
                    "as simulated and does not establish a production fault."
                ),
                "incident": IncidentSerializer(incident).data,
            },
            status=201,
        )


class IncidentListView(APIView):
    def get(self, request):
        cutoff = timezone.now() - timedelta(seconds=3)
        recoverable_ids = list(
            Incident.objects.filter(
                status__in=["ACTIVE", "INVESTIGATING"],
                created_at__lte=cutoff,
            ).values_list("id", flat=True)
        )

        for incident_id in recoverable_ids:
            recover_incident_safely(incident_id)

        if is_admin(request.user):
            queryset = Incident.objects.select_related(
                "affected_user", "transfer"
            ).all()
        else:
            queryset = Incident.objects.filter(
                affected_user=request.user
            ).select_related("affected_user", "transfer")

        return Response(IncidentSerializer(queryset[:100], many=True).data)


class IncidentDetailView(APIView):
    def get(self, request, pk):
        incident = Incident.objects.filter(pk=pk).first()
        if not incident:
            return Response({"detail": "Incident not found."}, status=404)
        if not is_admin(request.user) and incident.affected_user_id != request.user.id:
            return Response({"detail": "Not permitted."}, status=403)
        return Response(IncidentSerializer(incident).data)

    def post(self, request, pk):
        if not is_admin(request.user):
            return Response(
                {"detail": "Only admins can start an investigation."},
                status=403,
            )

        incident = Incident.objects.filter(pk=pk).first()
        if not incident:
            return Response({"detail": "Incident not found."}, status=404)

        if incident.status in ("ACTIVE", "RECOVERED", "VERIFIED"):
            if incident.status == "ACTIVE":
                incident.status = "INVESTIGATING"
                incident.save(update_fields=["status"])

        analysis = build_root_cause_analysis(incident)

        try:
            ai_summary = ollama_chat([
                {
                    "role": "system",
                    "content": (
                        "You are RootLens AI, a cautious incident-analysis assistant. "
                        "Use only the JSON evidence provided by the application. "
                        "Do not invent logs, timestamps, metrics, or root causes. "
                        "Clearly distinguish recorded facts from hypotheses. "
                        "Return a concise explanation and practical remediation steps."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({
                        "incident": IncidentSerializer(incident).data,
                        "deterministic_analysis": analysis,
                    }, default=str),
                },
            ])
            analysis["ai_summary"] = ai_summary
            analysis["ai_model"] = OLLAMA_MODEL
            analysis["ai_status"] = "available"
        except RuntimeError as exc:
            analysis["ai_summary"] = (
                "AI analysis is temporarily unavailable. The deterministic "
                "evidence ranking is still available."
            )
            analysis["ai_status"] = "unavailable"
            analysis["ai_error"] = str(exc)

        return Response({
            "incident": IncidentSerializer(incident).data,
            "analysis": analysis,
        })


class IncidentAnalysisView(APIView):
    def get(self, request, pk):
        incident = Incident.objects.filter(pk=pk).first()
        if not incident:
            return Response({"detail": "Incident not found."}, status=404)
        if not is_admin(request.user) and incident.affected_user_id != request.user.id:
            return Response({"detail": "Not permitted."}, status=403)

        return Response(build_root_cause_analysis(incident))


class IncidentChatView(APIView):
    def post(self, request):
        if not is_admin(request.user):
            return Response({"detail": "Admin access is required."}, status=403)

        question = str(request.data.get("message", "")).strip()
        incident_id = request.data.get("incident_id")

        if not question:
            return Response({"detail": "Enter a question."}, status=400)
        if len(question) > 4000:
            return Response({"detail": "Question is too long."}, status=400)

        incident_context = None
        if incident_id is not None:
            try:
                incident = Incident.objects.select_related("transfer").get(
                    pk=int(incident_id)
                )
            except (Incident.DoesNotExist, TypeError, ValueError):
                return Response({"detail": "Incident not found."}, status=404)
            incident_context = {
                "incident": IncidentSerializer(incident).data,
                "analysis": build_root_cause_analysis(incident),
            }

        messages = [{
            "role": "system",
            "content": (
                "You are the RootLens AI incident assistant. Answer from the supplied "
                "incident context only. Never invent timestamps, metrics, service logs, "
                "or events. If the evidence is insufficient, state exactly what is missing. "
                "Distinguish observed simulator facts from hypotheses. Give actionable "
                "remediation and verification steps when relevant."
            ),
        }]

        if incident_context:
            messages.append({
                "role": "system",
                "content": "Incident context JSON:\n" + json.dumps(
                    incident_context, default=str
                ),
            })

        messages.append({"role": "user", "content": question})

        try:
            answer = ollama_chat(messages)
        except RuntimeError as exc:
            return Response({
                "detail": str(exc),
                "ai_status": "unavailable",
            }, status=503)

        return Response({
            "answer": answer,
            "model": OLLAMA_MODEL,
            "ai_status": "available",
        })


class RecoverIncidentView(APIView):
    def post(self, request, pk):
        if not is_admin(request.user):
            return Response(
                {"detail": "Only admins can verify a fix."},
                status=403,
            )

        incident = Incident.objects.filter(pk=pk).first()
        if not incident:
            return Response({"detail": "Incident not found."}, status=404)

        incident.status = "VERIFIED"
        incident.verified_at = timezone.now()
        incident.save(update_fields=["status", "verified_at"])

        return Response({
            "message": "Marked verified for this simulated scenario.",
            "incident": IncidentSerializer(incident).data,
        })


class IncidentSourceAnalysisView(APIView):
    """Read-only source analysis for an authorized incident."""

    def get(self, request, pk):
        incident = (
            Incident.objects
            .select_related("affected_user", "transfer")
            .filter(pk=pk)
            .first()
        )

        if incident is None:
            return Response(
                {"detail": "Incident not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Only administrators or the affected user may inspect this incident.
        if (
            not is_admin(request.user)
            and incident.affected_user_id != request.user.id
        ):
            return Response(
                {"detail": "You are not permitted to analyze this incident."},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            from .source_analysis import analyze_incident_source

            result = analyze_incident_source(incident)

        except Exception:
            # Keep internal paths and exception details out of API responses.
            import logging

            logging.getLogger(__name__).exception(
                "Source analysis failed for incident %s",
                incident.pk,
            )

            return Response(
                {
                    "detail": (
                        "Source analysis failed. Check the Django "
                        "server terminal for the underlying error."
                    )
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response({
            "incident_id": incident.pk,
            **result,
        })
