from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, Protocol, Sequence


@dataclass(frozen=True)
class AnalyzerThresholds:
    assistant_steps_per_turn: int = 8
    tool_calls_per_turn: int = 12
    repeated_exact_tool_call_count: int = 3
    large_tool_payload_bytes: int = 40_000
    large_system_prompt_bytes: int = 100_000
    minimum_later_steps_for_retention: int = 2
    low_cache_reuse_min_workload_tokens: int = 100_000
    low_cache_reuse_ratio: float = 0.50
    same_model_child_min_api_calls: int = 10


DEFAULT_THRESHOLDS = AnalyzerThresholds()
METHODOLOGY_WARNING = (
    "Assistant steps are not an exact per-turn or provider-call mapping; "
    "persisted session-level API call counts cannot be attributed to individual turns."
)
ESTIMATED_TOKEN_METHOD = "ceil(payload_bytes / 4) * later_assistant_steps"


class TrajectoryStore(Protocol):
    def fetch_sessions(self, days: int, source: str | None, now: datetime) -> Sequence[Any]: ...

    def fetch_active_messages(
        self, days: int, source: str | None, now: datetime
    ) -> Sequence[Any]: ...


@dataclass(frozen=True)
class SessionRecord:
    id: str
    source: str | None


@dataclass(frozen=True)
class MessageRecord:
    session_id: str
    id: str | int | None
    role: str
    tool_name: str | None
    content: str | None
    tool_fingerprints: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class TurnRecord:
    session_id: str
    turn_index: int
    user_message_id: str | int | None
    assistant_steps: int
    tool_fingerprints: tuple[tuple[str, str], ...]


class SqliteStore:
    """Two-query, bound-SQL reader for the persisted session schema."""

    def __init__(self, connection):
        self._connection = connection

    def fetch_sessions(self, days: int, source: str | None, now: datetime):
        cutoff = (now - timedelta(days=days)).timestamp()
        if source is None:
            cursor = self._connection.execute(
                "SELECT id, source FROM sessions WHERE started_at >= ?", (cutoff,)
            )
        else:
            cursor = self._connection.execute(
                "SELECT id, source FROM sessions WHERE started_at >= ? AND source = ?",
                (cutoff, source),
            )
        return [_row_dict(row, ("id", "source")) for row in cursor]

    def fetch_active_messages(self, days: int, source: str | None, now: datetime):
        cutoff = (now - timedelta(days=days)).timestamp()
        query = (
            "SELECT m.session_id, m.id, m.role, m.tool_name, m.content, m.tool_calls "
            "FROM messages AS m "
            "JOIN sessions AS s ON s.id = m.session_id "
            "WHERE m.active = 1 AND s.started_at >= ?"
        )
        parameters: tuple[float, ...] | tuple[float, str] = (cutoff,)
        if source is not None:
            query += " AND s.source = ?"
            parameters = (cutoff, source)
        cursor = self._connection.execute(query + " ORDER BY m.session_id, m.id", parameters)
        return [
            _row_dict(
                row,
                ("session_id", "id", "role", "tool_name", "content", "tool_calls"),
            )
            for row in cursor
        ]


class RuntimeStore(SqliteStore):
    def __init__(self, session_db):
        super().__init__(session_db._conn)
        self._session_db = session_db

    def close(self):
        self._session_db.close()


def open_runtime_store() -> RuntimeStore:
    """Lazily import Hermes and open its state database read-only."""
    from hermes_state import SessionDB

    return RuntimeStore(SessionDB(read_only=True))


def validate_days(days: int, now: datetime | None = None) -> int:
    """Return a lookback that can be subtracted safely from ``now``."""
    reference = now or datetime.now(timezone.utc)
    maximum_days = (reference.date() - datetime.min.date()).days
    is_integer = isinstance(days, int) and not isinstance(days, bool)
    if not is_integer or not 1 <= days <= maximum_days:
        raise ValueError(
            f"days must be between 1 and {maximum_days} for the supplied timestamp"
        )
    return days


def _tool_call_fingerprints(tool_calls: Any) -> tuple[tuple[str, str], ...]:
    if not isinstance(tool_calls, list):
        return ()
    fingerprints = []
    for tool_call in tool_calls:
        function = _value(tool_call, "function")
        name = _value(function, "name") if function is not None else _value(tool_call, "name")
        raw_arguments = (
            _value(function, "arguments")
            if function is not None
            else _value(tool_call, "arguments")
        )
        arguments = _canonical_arguments(raw_arguments)
        if not isinstance(name, str) or not name or arguments is None:
            continue
        try:
            canonical = json.dumps(
                arguments, sort_keys=True, separators=(",", ":"), allow_nan=False
            )
        except (RecursionError, TypeError, ValueError):
            continue
        fingerprints.append((name, sha256(canonical.encode()).hexdigest()[:16]))
    return tuple(fingerprints)


def _canonical_arguments(arguments: Any):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments, object_pairs_hook=_unique_object)
        except (json.JSONDecodeError, RecursionError, ValueError):
            return None
    return arguments if isinstance(arguments, dict) else None


def _unique_object(pairs: list[tuple[Any, Any]]) -> dict[Any, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _tool_calls(row: Any):
    tool_calls = _value(row, "tool_calls")
    if isinstance(tool_calls, str):
        try:
            tool_calls = json.loads(tool_calls, object_pairs_hook=_unique_object)
        except (json.JSONDecodeError, RecursionError, TypeError, ValueError):
            tool_calls = ()
    if isinstance(tool_calls, list):
        return tool_calls
    content = _value(row, "content")
    if isinstance(content, str):
        try:
            content = json.loads(content, object_pairs_hook=_unique_object)
        except (json.JSONDecodeError, RecursionError, TypeError, ValueError):
            return ()
    if isinstance(content, dict):
        return content.get("tool_calls", ())
    return ()


def analyze(
    store: TrajectoryStore,
    days: int = 30,
    source: str | None = None,
    now: datetime | None = None,
    thresholds: AnalyzerThresholds = DEFAULT_THRESHOLDS,
):
    generated_at = now or datetime.now(timezone.utc)
    validated_days = validate_days(days, generated_at)
    sessions = _sessions(store.fetch_sessions(validated_days, source, generated_at))
    session_ids = tuple(session.id for session in sessions)
    messages = _messages(
        store.fetch_active_messages(validated_days, source, generated_at), set(session_ids)
    )
    turns = _turns(messages, session_ids)
    findings = [
        _finding(turn)
        for turn in turns
        if turn.assistant_steps > thresholds.assistant_steps_per_turn
    ]
    findings.extend(_detect_high_tool_fanout(turns, thresholds))
    findings.extend(_detect_repeated_exact_tool_calls(turns, thresholds))
    findings.extend(_large_tool_payload_findings(messages, turns, thresholds))
    return {
        "schema_version": 1,
        "days": days,
        "source_filter": source,
        "generated_at": generated_at.timestamp(),
        "sessions_analyzed": len(sessions),
        "turns_analyzed": len(turns),
        "summary": {
            "finding_count": len(findings),
            "sessions_with_findings": len({finding["session_id"] for finding in findings}),
            "by_code": _counts(findings, "code"),
            "by_severity": _counts(findings, "severity"),
            "estimated_avoidable_tokens": sum(
                finding["impact"]["tokens"]
                for finding in findings
                if finding["impact"]["kind"] == "estimated_avoidable_workload"
            ),
            "benchmark_required_tokens": 0,
            "methodology_note": METHODOLOGY_WARNING,
        },
        "findings": findings,
    }


def _sessions(rows: Sequence[Any]) -> tuple[SessionRecord, ...]:
    records = []
    for row in rows:
        session_id = _value(row, "id")
        if isinstance(session_id, str) and session_id:
            source = _value(row, "source")
            records.append(SessionRecord(session_id, source if isinstance(source, str) else None))
    return tuple(records)


def _messages(rows: Sequence[Any], session_ids: set[str]) -> tuple[MessageRecord, ...]:
    records = []
    for row in rows:
        session_id, role = _value(row, "session_id"), _value(row, "role")
        if (
            isinstance(session_id, str)
            and isinstance(role, str)
            and session_id in session_ids
            and role in {"user", "assistant", "tool"}
        ):
            message_id = _value(row, "id")
            tool_name = _value(row, "tool_name")
            content = _value(row, "content")
            records.append(
                MessageRecord(
                    session_id,
                    message_id if isinstance(message_id, (str, int)) and not isinstance(message_id, bool) else None,
                    role,
                    tool_name if isinstance(tool_name, str) else None,
                    content if isinstance(content, str) else None,
                    _tool_call_fingerprints(_tool_calls(row)),
                )
            )
    return tuple(records)


def _turns(messages: Sequence[MessageRecord], session_ids: Sequence[str]) -> tuple[TurnRecord, ...]:
    active: dict[str, int | None] = {session_id: None for session_id in session_ids}
    counts = {session_id: 0 for session_id in session_ids}
    turns: list[TurnRecord] = []
    for message in messages:
        if message.role == "user":
            counts[message.session_id] += 1
            turns.append(
                TurnRecord(message.session_id, counts[message.session_id], message.id, 0, ())
            )
            active[message.session_id] = len(turns) - 1
        elif message.role == "assistant" and active[message.session_id] is not None:
            index = active[message.session_id]
            assert index is not None
            turn = turns[index]
            turns[index] = TurnRecord(
                turn.session_id,
                turn.turn_index,
                turn.user_message_id,
                turn.assistant_steps + 1,
                turn.tool_fingerprints + message.tool_fingerprints,
            )
    return tuple(turns)


def _large_tool_payload_findings(
    messages: Sequence[MessageRecord],
    turns: Sequence[TurnRecord],
    thresholds: AnalyzerThresholds,
) -> list[dict[str, Any]]:
    turn_user_message_ids = {
        (turn.session_id, turn.turn_index): turn.user_message_id for turn in turns
    }
    turn_indices: dict[str, int] = {}
    candidates: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "user":
            turn_indices[message.session_id] = turn_indices.get(message.session_id, 0) + 1
        elif message.role == "tool" and message.session_id in turn_indices and message.content is not None:
            payload_bytes = len(message.content.encode("utf-8", "replace"))
            if payload_bytes > thresholds.large_tool_payload_bytes:
                candidates.append(
                    {
                        "session_id": message.session_id,
                        "turn_index": turn_indices[message.session_id],
                        "turn_user_message_id": turn_user_message_ids[
                            (message.session_id, turn_indices[message.session_id])
                        ],
                        "tool_message_id": message.id,
                        "tool_name": message.tool_name,
                        "payload_bytes": payload_bytes,
                        "later_assistant_steps": 0,
                    }
                )
        elif message.role == "assistant":
            for candidate in candidates:
                if (
                    candidate["session_id"] == message.session_id
                    and candidate["turn_index"] == turn_indices.get(message.session_id)
                ):
                    candidate["later_assistant_steps"] += 1
    return [
        _large_tool_payload_finding(candidate)
        for candidate in candidates
        if candidate["later_assistant_steps"] >= thresholds.minimum_later_steps_for_retention
    ]


def _large_tool_payload_finding(candidate: dict[str, Any]) -> dict[str, Any]:
    estimated_tokens = (candidate["payload_bytes"] + 3) // 4 * candidate["later_assistant_steps"]
    return {
        "code": "large_tool_payload",
        "severity": "high",
        "session_id": candidate["session_id"],
        "turn_index": candidate["turn_index"],
        "turn_user_message_id": candidate["turn_user_message_id"],
        "tool_message_id": candidate["tool_message_id"],
        "tool_name": candidate["tool_name"],
        "observed": {
            "payload_bytes": candidate["payload_bytes"],
            "later_assistant_steps": candidate["later_assistant_steps"],
        },
        "impact": {
            "kind": "estimated_avoidable_workload",
            "tokens": estimated_tokens,
            "method": ESTIMATED_TOKEN_METHOD,
        },
    }


def _finding(turn: TurnRecord) -> dict[str, Any]:
    return {
        "code": "high_assistant_steps_per_turn",
        "severity": "high",
        "session_id": turn.session_id,
        "turn_index": turn.turn_index,
        "assistant_steps": turn.assistant_steps,
        "impact": {"kind": "measured_exposure", "assistant_steps": turn.assistant_steps},
    }


def _detect_high_tool_fanout(
    turns: Sequence[TurnRecord], thresholds: AnalyzerThresholds
) -> list[dict[str, Any]]:
    return [
        {
            "code": "high_tool_fanout_per_turn",
            "severity": "high",
            "session_id": turn.session_id,
            "turn_index": turn.turn_index,
            "tool_calls": len(turn.tool_fingerprints),
            "impact": {
                "kind": "measured_exposure",
                "tool_calls": len(turn.tool_fingerprints),
            },
        }
        for turn in turns
        if len(turn.tool_fingerprints) > thresholds.tool_calls_per_turn
    ]


def _detect_repeated_exact_tool_calls(
    turns: Sequence[TurnRecord], thresholds: AnalyzerThresholds
) -> list[dict[str, Any]]:
    findings = []
    for turn in turns:
        counts = Counter(turn.tool_fingerprints)
        for (tool_name, fingerprint), repeat_count in counts.items():
            if repeat_count >= thresholds.repeated_exact_tool_call_count:
                findings.append(
                    {
                        "code": "repeated_exact_tool_call",
                        "severity": "medium",
                        "session_id": turn.session_id,
                        "turn_index": turn.turn_index,
                        "tool_name": tool_name,
                        "fingerprint": fingerprint,
                        "repeat_count": repeat_count,
                        "impact": {
                            "kind": "benchmark_required",
                            "repeat_count": repeat_count,
                        },
                    }
                )
    return findings


def _counts(findings: Sequence[dict[str, Any]], field: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for finding in findings:
        value = finding[field]
        counts[value] = counts.get(value, 0) + 1
    return counts


def _value(row: Any, field: str):
    if isinstance(row, dict):
        return row.get(field)
    try:
        return row[field]
    except (KeyError, TypeError, IndexError):
        return getattr(row, field, None)


def _row_dict(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if hasattr(row, "keys"):
        return dict(row)
    return dict(zip(fields, row))
