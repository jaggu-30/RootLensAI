
"""Read-only, evidence-driven source analysis for RootLens AI.

Algorithms:
1. Rule-based incident event correlation.
2. TF-IDF/cosine textual relevance.
3. Python AST and best-effort JavaScript function/call-graph analysis.

The ranking is a heuristic investigation aid, not proof of causation.
No source files are executed or modified.
"""

import ast
import math
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from django.conf import settings


# Project paths
PROJECT_ROOT = (Path(settings.BASE_DIR) / "..").resolve()

ALLOWED_ROOTS = [
    Path(settings.BASE_DIR) / "banking",
    Path(settings.BASE_DIR) / "config",
    PROJECT_ROOT / "frontend" / "src",
]

SKIP_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    "dist",
    "build",
    "coverage",
    ".next",
    "migrations",
}

EXTENSIONS = {".py", ".js", ".jsx", ".ts", ".tsx"}

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{1,}")

MAX_FILES = 400
MAX_BYTES = 300_000
MAX_FINDINGS = 12

# Terms are investigation hints, not proof that a particular failure occurred.
FAULT_SIGNALS = {
    "delayed_credit": {
        "credit", "credited", "receiver", "transfer", "transaction",
        "delay", "delayed", "recover", "recovery", "pending",
        "debit", "debited", "timestamp", "event",
    },
    "stale_balance": {
        "balance", "cache", "cached", "refresh", "stale", "account",
        "read", "update", "invalidate", "transaction",
    },
    "network_timeout": {
        "network", "timeout", "timed", "request", "response",
        "retry", "connection", "http", "socket", "exception",
    },
    "database_failure": {
        "database", "db", "query", "transaction", "atomic",
        "connection", "commit", "rollback", "integrity", "save",
    },
    "duplicate_request": {
        "duplicate", "idempotency", "request", "transaction",
        "retry", "unique", "uuid", "transfer", "submission",
    },
    "service_crash": {
        "worker", "service", "crash", "thread", "process",
        "exception", "failure", "recovery", "restart", "task",
    },
    "queue_backlog": {
        "queue", "backlog", "worker", "consumer", "event",
        "task", "retry", "pending", "processing", "delay",
    },
    "bad_config": {
        "config", "configuration", "settings", "environment",
        "timeout", "url", "model", "database", "service",
    },
}

GENERIC_FAILURE_TERMS = {
    "error", "failed", "failure", "exception", "timeout",
    "retry", "incident", "transfer", "transaction",
    "service", "request", "response", "event",
}

# Very common language tokens add little diagnostic value.
STOP_WORDS = {
    "the", "and", "for", "with", "from", "this", "that",
    "then", "than", "into", "when", "where", "what", "which",
    "there", "their", "have", "has", "had", "was", "were",
    "are", "been", "being", "will", "would", "should", "could",
    "can", "not", "but", "all", "any", "only", "also", "its",
    "our", "your", "you", "they", "them", "who", "how",
    "does", "did", "done", "get", "set", "use", "used",
    "using", "return", "none", "true", "false", "self",
}


def tokens(text):
    """Normalize text into useful lowercase identifier and word tokens."""
    return [
        token.lower()
        for token in TOKEN_RE.findall(str(text or ""))
        if token.lower() not in STOP_WORDS
    ]


def _event_text(event):
    """Flatten the known event fields into searchable text."""
    values = []

    for key in (
        "kind",
        "event_type",
        "service",
        "source",
        "message",
        "details",
        "level",
        "description",
    ):
        value = event.get(key)

        if isinstance(value, (dict, list)):
            values.append(str(value))
        elif value is not None:
            values.append(str(value))

    return " ".join(values)


def _parse_time(value):
    """Parse an ISO timestamp when possible; return None when unavailable."""
    if not value:
        return None

    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed
    except (TypeError, ValueError, OverflowError):
        return None



def correlate_events(incident):
    """Correlate evidence while distinguishing simulated from observed faults."""
    evidence = getattr(incident, "evidence", None)
    events = evidence if isinstance(evidence, list) else []

    fault_type = str(
        getattr(incident, "fault_type", "") or ""
    ).lower().strip()

    timeline = []
    observations = []
    signals = set()
    evidence_strength = {}
    simulated_signals = set()
    observed_signals = set()

    # Map each fault type to the exact structured signal emitted by the
    # simulator, plus common explicit event-log phrases.
    fault_patterns = {
        "delayed_credit": {
            "credit_delay": (
                "sender_debited",
                "receiver_credit_delayed",
                "credit delayed",
                "credit pending",
                "receiver credit failed",
            ),
        },
        "stale_balance": {
            "stale_balance": (
                "stale_cache_value",
                "balance_refresh_required",
                "stale balance",
                "outdated balance",
                "cache invalidation failed",
                "balance mismatch",
            ),
        },
        "network_timeout": {
            "timeout": (
                "simulated_request_timeout",
                "timed out",
                "timeout exceeded",
                "deadline exceeded",
                "connection timeout",
            ),
        },
        "database_failure": {
            "database_failure": (
                "simulated_database_connection_failure",
                "database error",
                "database failure",
                "database unavailable",
                "connection refused",
                "transaction rollback",
            ),
        },
        "duplicate_request": {
            "duplicate": (
                "simulated_duplicate_request",
                "duplicate request",
                "duplicate transaction",
                "idempotency conflict",
                "already processed",
            ),
        },
        "service_crash": {
            "worker_failure": (
                "simulated_worker_interruption",
                "service crashed",
                "worker crashed",
                "process terminated",
                "worker stopped",
                "worker unavailable",
                "uncaught exception",
                "unhandled exception",
                "traceback",
            ),
        },
        "queue_backlog": {
            "queue_backlog": (
                "simulated_queue_backlog",
                "queue backlog",
                "queue depth exceeded",
                "consumer lag",
                "queue is full",
                "messages pending",
            ),
        },
        "bad_config": {
            "configuration_failure": (
                "simulated_invalid_configuration",
                "invalid configuration",
                "configuration error",
                "missing environment variable",
                "invalid service url",
            ),
        },
    }

    def add_signal(signal, strength, is_simulated, observation):
        signals.add(signal)
        evidence_strength[signal] = max(
            strength,
            evidence_strength.get(signal, 0.0),
        )

        if is_simulated:
            simulated_signals.add(signal)
        else:
            observed_signals.add(signal)

        if observation not in observations:
            observations.append(observation)

    for index, event in enumerate(events):
        if not isinstance(event, dict):
            continue

        timestamp = str(
            event.get("time")
            or event.get("timestamp")
            or event.get("created_at")
            or ""
        )

        event_text = _event_text(event).lower()
        kind = str(
            event.get("kind")
            or event.get("event_type")
            or event.get("level")
            or "event"
        )

        source = str(event.get("source") or "").lower()
        origin = str(event.get("evidence_origin") or "").lower()

        is_simulated = (
            origin == "simulated"
            or source in {
                "rootlens_simulation",
                "recorded_simulator_event",
            }
            or "simulation" in kind.lower()
            or "simulator" in kind.lower()
            or "simulator" in str(event.get("service") or "").lower()
        )

        timeline.append({
            "index": index,
            "time": timestamp,
            "kind": kind,
            "service": str(
                event.get("service")
                or event.get("source")
                or "unknown"
            ),
            "message": str(
                event.get("message")
                or event.get("description")
                or ""
            )[:500],
            "text": _event_text(event),
            "evidence_origin": (
                "simulated" if is_simulated else "recorded"
            ),
            "_parsed_time": _parse_time(timestamp),
        })

        # Prefer explicit structured signals when present.
        raw_signals = event.get("signals", [])
        if isinstance(raw_signals, list):
            for raw_signal in raw_signals:
                signal_text = str(raw_signal).lower().strip()

                for canonical_signal, phrases in fault_patterns.get(
                    fault_type, {}
                ).items():
                    if any(
                        phrase == signal_text
                        or phrase in signal_text
                        for phrase in phrases
                    ):
                        add_signal(
                            canonical_signal,
                            0.7 if is_simulated else 1.0,
                            is_simulated,
                            (
                                f"{'Simulated' if is_simulated else 'Recorded'} "
                                f"fault-specific signal: {signal_text}."
                            ),
                        )

        # Also inspect event text for explicit fault-specific phrases.
        for canonical_signal, phrases in fault_patterns.get(
            fault_type, {}
        ).items():
            if any(phrase in event_text for phrase in phrases):
                add_signal(
                    canonical_signal,
                    0.7 if is_simulated else 1.0,
                    is_simulated,
                    (
                        f"{'Simulated' if is_simulated else 'Recorded'} "
                        f"evidence matched {canonical_signal}."
                    ),
                )

    # Sort events chronologically only if all timestamps can be parsed.
    if timeline and all(item["_parsed_time"] for item in timeline):
        timeline.sort(key=lambda item: item["_parsed_time"])
    else:
        timeline.sort(key=lambda item: item["index"])

    # Preserve debit/credit order as context, not proof of a fault.
    kinds = [
        item["kind"].lower().replace("_", " ")
        for item in timeline
    ]

    debit_positions = [
        index for index, kind in enumerate(kinds)
        if "sender debited" in kind or kind == "debited"
    ]
    credit_positions = [
        index for index, kind in enumerate(kinds)
        if "receiver credited" in kind or kind == "credited"
    ]

    if debit_positions and credit_positions:
        if debit_positions[0] < credit_positions[0]:
            observations.append(
                "Transaction context: sender debit precedes receiver "
                "credit. This order alone does not establish a fault."
            )
        else:
            observations.append(
                "Transaction context: receiver credit appears before "
                "sender debit; verify event meanings and timestamps."
            )

    # Generic errors are weak context only; they never confirm a fault.
    all_text = " ".join(item["text"].lower() for item in timeline)
    if any(
        phrase in all_text
        for phrase in (
            "exception", "traceback", "failed",
            "failure", "error", "unavailable",
        )
    ):
        observations.append(
            "Generic error wording was found; it does not by itself "
            "confirm the incident's specific fault type."
        )

    if simulated_signals:
        observations.append(
            "Fault-specific evidence was generated by a simulator. "
            "It confirms the modeled scenario only, not a real production failure."
        )

    if not signals:
        observations.append(
            f"No explicit fault-specific signal was found for {fault_type}. "
            "Inspect logs and telemetry before assigning a root cause."
        )

    public_timeline = [
        {
            key: value
            for key, value in item.items()
            if not key.startswith("_")
        }
        for item in timeline[:80]
    ]

    # A signal is production-confirmed only when matching evidence is not
    # explicitly marked as simulated. This remains a heuristic; validate
    # provenance in the ingestion pipeline for high-assurance use.
    fault_specific_match = bool(observed_signals)

    return {
        "event_count": len(timeline),
        "timeline": public_timeline,
        "observations": observations,
        "signals": sorted(signals),
        "evidence_strength": evidence_strength,
        "simulated_signals": sorted(simulated_signals),
        "observed_signals": sorted(observed_signals),
        "fault_type": fault_type,
        "fault_specific_match": fault_specific_match,
        "simulated_scenario_match": bool(simulated_signals),
        "limitations": (
            "A simulated signal identifies a modeled scenario, not a "
            "production failure. Recorded evidence requires provenance "
            "validation and corroboration before a root cause is confirmed."
        ),
    }




def python_symbols(source):
    """Algorithm 3: discover Python functions/classes and their call identifiers."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, TypeError):
        return []

    symbols = []

    class DefinitionVisitor(ast.NodeVisitor):
        def __init__(self):
            self.definitions = []

        def visit_FunctionDef(self, node):
            self.definitions.append(node)
            # Do not count nested function calls as calls made by this function.
            for child in node.body:
                if not isinstance(
                    child,
                    (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
                ):
                    self.visit(child)

        def visit_AsyncFunctionDef(self, node):
            self.definitions.append(node)
            for child in node.body:
                if not isinstance(
                    child,
                    (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
                ):
                    self.visit(child)

        def visit_ClassDef(self, node):
            self.definitions.append(node)
            for child in node.body:
                if not isinstance(
                    child,
                    (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
                ):
                    self.visit(child)

    visitor = DefinitionVisitor()
    visitor.visit(tree)

    for node in visitor.definitions:
        calls = set()

        for child in ast.walk(node):
            if child is node:
                continue

            # Exclude nested function/class bodies from the parent call list.
            if isinstance(
                child,
                (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
            ):
                continue

            if isinstance(child, ast.Call):
                func = child.func

                if isinstance(func, ast.Name):
                    calls.add(func.id)
                elif isinstance(func, ast.Attribute):
                    calls.add(func.attr)

        symbols.append({
            "name": node.name,
            "start": node.lineno,
            "end": getattr(node, "end_lineno", node.lineno),
            "calls": sorted(calls),
            "kind": (
                "class"
                if isinstance(node, ast.ClassDef)
                else "function"
            ),
        })

    return symbols


def js_symbols(source):
    """Best-effort JS/JSX function discovery without executing source code."""
    patterns = [
        re.compile(r"(?:async\s+)?function\s+([\w$]+)\s*\("),
        re.compile(
            r"(?:const|let|var)\s+([\w$]+)\s*=\s*"
            r"(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>"
        ),
        re.compile(
            r"^\s*(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{"
        ),
    ]

    lines = source.splitlines()
    starts = []

    for line_number, line in enumerate(lines, 1):
        for pattern in patterns:
            match = pattern.search(line)

            if match:
                name = match.group(1)

                if name not in {"if", "for", "while", "switch", "catch"}:
                    starts.append((name, line_number))
                    break

    # Keep only the first definition found for a name at a given line.
    starts = sorted(set(starts), key=lambda item: item[1])
    result = []

    for index, (name, start) in enumerate(starts):
        end = min(
            len(lines),
            starts[index + 1][1] - 1
            if index + 1 < len(starts)
            else start + 99,
        )

        block = "\n".join(lines[start - 1:end])
        calls = sorted(set(re.findall(r"\b([\w$]+)\s*\(", block)))

        result.append({
            "name": name,
            "start": start,
            "end": max(start, end),
            "calls": calls,
            "kind": "function",
        })

    return result


def cosine_tfidf(query_tokens, document_tokens, document_frequency, count):
    """Dependency-free TF-IDF cosine similarity."""
    query_tf = Counter(query_tokens)
    doc_tf = Counter(document_tokens)

    if not query_tf or not doc_tf:
        return 0.0

    vocabulary = set(query_tf) | set(doc_tf)

    def weight(tf, term):
        if not tf:
            return 0.0

        idf = math.log(
            1 + (count + 1) / (1 + document_frequency[term])
        ) + 1

        return (1 + math.log(tf)) * idf

    query_vector = {
        term: weight(query_tf[term], term)
        for term in vocabulary
    }
    document_vector = {
        term: weight(doc_tf[term], term)
        for term in vocabulary
    }

    dot = sum(
        query_vector[term] * document_vector[term]
        for term in vocabulary
    )

    query_norm = math.sqrt(
        sum(value * value for value in query_vector.values())
    )
    document_norm = math.sqrt(
        sum(value * value for value in document_vector.values())
    )

    if not query_norm or not document_norm:
        return 0.0

    return dot / (query_norm * document_norm)


def _incident_query(incident, correlation):
    """Build a query from incident metadata and recorded evidence."""
    values = []

    for field in (
        "fault_type",
        "title",
        "description",
        "hypothesis",
        "status",
    ):
        values.append(str(getattr(incident, field, "") or ""))

    evidence = getattr(incident, "evidence", None)

    if isinstance(evidence, list):
        for event in evidence:
            if isinstance(event, dict):
                values.append(_event_text(event))

    values.extend(correlation.get("observations", []))
    values.extend(correlation.get("signals", []))

    return " ".join(values)


def _fault_terms(incident, correlation):
    """Return diagnostic terms grounded in incident type and observed signals."""
    fault_type = str(getattr(incident, "fault_type", "") or "").lower()
    terms = set(FAULT_SIGNALS.get(fault_type, set()))

    observed_signals = set(correlation.get("signals", []))
    terms.update(observed_signals)

    # Generic failure words are only added when the evidence mentions them.
    event_text = " ".join(
        str(item.get("text", ""))
        for item in correlation.get("timeline", [])
    ).lower()

    for term in GENERIC_FAILURE_TERMS:
        if term in event_text:
            terms.add(term)

    return terms


def _relationship_scores(documents, lexical_scores):
    """Estimate relationships between symbols using discovered call identifiers.

    This is a lightweight static heuristic. It is not a complete dependency
    graph and does not prove that a call ran during the incident.
    """
    by_name = defaultdict(list)

    for index, document in enumerate(documents):
        by_name[document["symbol"].lower()].append(index)

    related = [0.0] * len(documents)
    explanations = [[] for _ in documents]

    for index, document in enumerate(documents):
        calls = {
            call.lower()
            for call in document["calls"]
            if isinstance(call, str)
        }

        # If this function calls a strongly matching function, consider it
        # related to the incident candidate.
        for call in calls:
            for target_index in by_name.get(call, []):
                if target_index == index:
                    continue

                target_score = lexical_scores[target_index]

                if target_score >= 0.08:
                    related[index] = max(
                        related[index],
                        min(1.0, target_score),
                    )

                    explanations[index].append(
                        f"Calls potentially relevant symbol "
                        f"{documents[target_index]['symbol']} "
                        f"in {documents[target_index]['path']}."
                    )

        # If a strongly matching function calls this function, this function
        # may be part of the same execution path.
        target_name = document["symbol"].lower()

        for source_index, source in enumerate(documents):
            if source_index == index:
                continue

            source_calls = {
                call.lower()
                for call in source["calls"]
                if isinstance(call, str)
            }

            if target_name in source_calls and lexical_scores[source_index] >= 0.08:
                related[index] = max(
                    related[index],
                    min(1.0, lexical_scores[source_index] * 0.8),
                )

                explanations[index].append(
                    f"Potential caller: {source['symbol']} "
                    f"in {source['path']}."
                )

    return related, explanations



def analyze_incident_source(incident):
    """Rank source candidates using incident evidence and fault-specific signals."""
    correlation = correlate_events(incident)

    fault_type = str(getattr(incident, "fault_type", "") or "").lower()
    fault_confirmed = bool(correlation.get("fault_specific_match", False))
    observed_signals = set(correlation.get("signals", []))

    # Use incident metadata for context, but do not treat ordinary transaction
    # events as proof of a failure.
    metadata_parts = [
        str(getattr(incident, field, "") or "")
        for field in ("title", "description", "hypothesis")
    ]
    incident_text = " ".join(metadata_parts)
    query_tokens = tokens(incident_text)

    # Only use explicitly observed signals as diagnostic evidence.
    diagnostic_terms = set(observed_signals)

    # Fault-specific vocabulary is used only when the event correlation
    # confirms the corresponding fault. A label alone is not proof.
    if fault_confirmed:
        diagnostic_terms.update(FAULT_SIGNALS.get(fault_type, set()))

    project_root = PROJECT_ROOT.resolve()
    documents = []
    scanned_files = 0
    scan_warnings = []

    for allowed_root in ALLOWED_ROOTS:
        try:
            base = allowed_root.resolve()
            base.relative_to(project_root)
        except (OSError, ValueError):
            scan_warnings.append(
                "A configured source root was outside the project root."
            )
            continue

        if not base.exists():
            scan_warnings.append(
                f"Configured source directory was not found: {base}"
            )
            continue

        for path in base.rglob("*"):
            if scanned_files >= MAX_FILES:
                break

            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                continue

            if any(
                part in SKIP_DIRS or part.startswith(".")
                for part in path.parts
            ):
                continue

            try:
                if path.stat().st_size > MAX_BYTES:
                    continue

                source = path.read_text(
                    encoding="utf-8",
                    errors="replace",
                )
                relative_path = path.resolve().relative_to(
                    project_root
                ).as_posix()
            except (OSError, ValueError):
                continue

            scanned_files += 1
            lines = source.splitlines()

            if path.suffix.lower() == ".py":
                symbols = python_symbols(source)
            else:
                symbols = js_symbols(source)

            if not symbols:
                symbols = [{
                    "name": "(file-level match)",
                    "start": 1,
                    "end": min(len(lines), 30),
                    "calls": [],
                    "kind": "file",
                }]

            for symbol in symbols:
                start = symbol["start"]
                end = min(symbol["end"], start + 199)
                excerpt = "\n".join(lines[start - 1:end])

                document_tokens = tokens(
                    relative_path.replace("/", " ")
                    + " "
                    + symbol["name"]
                    + " "
                    + excerpt
                )

                documents.append({
                    "path": relative_path,
                    "symbol": symbol["name"],
                    "symbol_kind": symbol.get("kind", "function"),
                    "start_line": start,
                    "end_line": end,
                    "calls": symbol["calls"],
                    "text": excerpt,
                    "tokens": document_tokens,
                    "lines": lines,
                })

    document_frequency = Counter()
    for document in documents:
        document_frequency.update(set(document["tokens"]))

    lexical_scores = [
        cosine_tfidf(
            query_tokens,
            document["tokens"],
            document_frequency,
            max(1, len(documents)),
        )
        for document in documents
    ]

    relationship_scores, relationship_reasons = _relationship_scores(
        documents,
        lexical_scores,
    )

    findings = []

    for index, document in enumerate(documents):
        document_token_set = set(document["tokens"])

        matched_terms = sorted(
            set(query_tokens) & document_token_set
        )
        matched_diagnostic_terms = sorted(
            diagnostic_terms & document_token_set
        )

        lexical_component = min(1.0, lexical_scores[index] * 5.0)

        if diagnostic_terms:
            domain_component = min(
                1.0,
                len(matched_diagnostic_terms)
                / min(5, len(diagnostic_terms)),
            )
        else:
            domain_component = 0.0

        relationship_component = relationship_scores[index]

        # Without a fault-specific match, do not allow generic textual
        # similarity or inferred call relationships to dominate the ranking.
        if not fault_confirmed:
            combined = (
                0.20 * lexical_component
                + 0.80 * domain_component
            )
            relationship_component = 0.0
        else:
            combined = (
                0.35 * lexical_component
                + 0.50 * domain_component
                + 0.15 * relationship_component
            )

        if combined < 0.08:
            continue

        start = document["start_line"]
        excerpt_end = min(document["end_line"], start + 11)
        excerpt = "\n".join(
            document["lines"][start - 1:excerpt_end]
        )

        reasons = []

        if matched_terms:
            reasons.append(
                "Textual similarity matches incident metadata."
            )

        if matched_diagnostic_terms:
            reasons.append(
                "Matches observed diagnostic signals: "
                + ", ".join(matched_diagnostic_terms[:8])
                + "."
            )

        if fault_confirmed and relationship_reasons[index]:
            reasons.extend(relationship_reasons[index][:3])

        if not fault_confirmed:
            reasons.append(
                "The event evidence does not confirm this fault; "
                "this result is not a confirmed root cause."
            )

        if not reasons:
            reasons.append(
                "Low-confidence heuristic candidate; requires verification."
            )

        findings.append({
            "path": document["path"],
            "symbol": document["symbol"],
            "symbol_kind": document["symbol_kind"],
            "start_line": start,
            "end_line": document["end_line"],
            "score": round(combined * 100, 1),
            "score_components": {
                "text_similarity": round(lexical_component * 100, 1),
                "incident_signal_match": round(domain_component * 100, 1),
                "call_relationship": round(
                    relationship_component * 100, 1
                ),
            },
            "matched_terms": matched_terms[:15],
            "matched_diagnostic_terms": matched_diagnostic_terms[:12],
            "calls": document["calls"][:25],
            "related_symbols": (
                relationship_reasons[index][:5]
                if fault_confirmed else []
            ),
            "excerpt": excerpt[:2200],
            "reason": " ".join(reasons)
            + " Scores are heuristic rankings, not probabilities or proof.",
        })

    findings.sort(
        key=lambda item: (
            item["score"],
            len(item["matched_diagnostic_terms"]),
            len(item["matched_terms"]),
        ),
        reverse=True,
    )

    unique = []
    seen = set()

    for finding in findings:
        key = (finding["path"], finding["symbol"])
        if key in seen:
            continue

        seen.add(key)
        unique.append(finding)

        if len(unique) >= MAX_FINDINGS:
            break

    return {
        "mode": "read-only",
        "algorithms": [
            {
                "name": "Rule-based event correlation",
                "status": "complete",
                "purpose": (
                    "Orders recorded events and identifies recognizable "
                    "fault-specific evidence."
                ),
            },
            {
                "name": "TF-IDF + cosine similarity",
                "status": "complete",
                "purpose": (
                    "Ranks source symbols using incident metadata, with "
                    "fault-specific evidence separated from generic context."
                ),
            },
            {
                "name": "AST/static structure analysis",
                "status": "complete",
                "purpose": (
                    "Extracts source symbols and approximate call relationships."
                ),
            },
        ],
        "scoring": {
            "method": "evidence_gated_weighted_heuristic",
            "fault_confirmed": fault_confirmed,
            "weights": (
                {
                    "text_similarity": 0.35,
                    "incident_signal_match": 0.50,
                    "call_relationship": 0.15,
                }
                if fault_confirmed
                else {
                    "text_similarity": 0.20,
                    "incident_signal_match": 0.80,
                    "call_relationship": 0.0,
                }
            ),
            "warning": (
                "Scores are ranking heuristics, not calibrated probabilities. "
                "If fault-specific evidence is absent, the results cannot "
                "establish a root cause."
            ),
        },
        "scanned_files": scanned_files,
        "event_correlation": correlation,
        "findings": unique,
        "scan_warnings": scan_warnings,
        "note": (
            "Analysis is read-only. Source files are not executed or modified. "
            "Static relationships are approximate; verify candidates against "
            "runtime logs and reproducible behavior."
        ),
    }
