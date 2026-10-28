
import json
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

    def add_candidate(name, score, supporting, missing, solution, verify):
        candidates.append({
            "cause": name,
            "score": max(0, min(100, int(score))),
            "supporting_evidence": supporting,
            "missing_evidence": missing,
            "solution": solution,
            "verification": verify,
        })

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
        supporting = [
            f"Recorded incident scenario type: {fault_type}.",
        ]
        score = 45

        # The predefined scenario is evidence of what the simulator selected,
        # not independent proof of an underlying production root cause.
        if transfer_obj and transfer_obj.sender_debited_at:
            supporting.append("Sender-debit timestamp is recorded.")
            score += 10

        if transfer_obj and transfer_obj.receiver_credited_at:
            supporting.append("Receiver-credit timestamp is recorded.")
            score += 10

        if (
            transfer_obj
            and transfer_obj.sender_debited_at
            and transfer_obj.receiver_credited_at
            and transfer_obj.receiver_credited_at > transfer_obj.sender_debited_at
        ):
            supporting.append("Receiver credit occurred after sender debit.")
            score += 15

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
        )

    # Alternative hypotheses remain lower-ranked unless independent evidence
    # is actually present. Do not invent service logs to support them.
    alternatives = [
        ("Network timeout or retry handling", "network_timeout"),
        ("Database connectivity or transaction failure", "database_failure"),
        ("Queue backlog or consumer lag", "queue_backlog"),
        ("Worker interruption", "service_crash"),
        ("Stale balance or cache refresh", "stale_balance"),
        ("Duplicate request or idempotency handling", "duplicate_request"),
        ("Service configuration regression", "bad_config"),
        ("Receiver-credit processing delay", "delayed_credit"),
    ]

    existing_names = {item["cause"] for item in candidates}
    for name, key in alternatives:
        catalog_item = cause_catalog[key]
        if name in existing_names or catalog_item[0] in existing_names:
            continue
        add_candidate(
            catalog_item[0],
            15,
            ["This is a possible failure mode, not a confirmed cause."],
            ["No independent evidence currently confirms this candidate."],
            catalog_item[1],
            catalog_item[2],
        )

    candidates.sort(key=lambda item: item["score"], reverse=True)
    primary = candidates[0] if candidates else None

    return {
        "incident_key": incident.incident_key,
        "score_type": "deterministic_evidence_match",
        "score_warning": (
            "Scores are heuristic evidence-match scores, not calibrated "
            "probabilities or proof of a production root cause."
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
    def post(self, request):
        if not is_admin(request.user):
            return Response(
                {"detail": "Only admins can run standalone fault scenarios."},
                status=403,
            )

        fault_type = str(request.data.get("fault_type", "network_timeout"))
        if fault_type not in FAULTS:
            return Response({"detail": "Unknown predefined fault."}, status=400)

        target_name = str(request.data.get("username", "demo_user"))
        target = User.objects.filter(username=target_name).first()
        info = FAULTS[fault_type]
        now = timezone.now()

        incident = Incident.objects.create(
            incident_key=f"INC-{uuid.uuid4().hex[:8].upper()}",
            title=info["label"],
            fault_type=fault_type,
            description=info["description"],
            severity=info["severity"],
            affected_user=target,
            evidence=[{
                "time": now.isoformat(),
                "kind": "simulator_event",
                "service": "rootlens-simulator",
                "message": f"Predefined scenario selected: {fault_type}.",
                "level": "INFO",
                "source": "recorded_simulator_event",
            }],
            hypothesis=info["hypothesis"],
            status="RECOVERED",
            recovered_at=now,
        )

        return Response({
            "message": "Predefined fault simulated. Scenario evidence saved.",
            "incident": IncidentSerializer(incident).data,
        }, status=201)


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
