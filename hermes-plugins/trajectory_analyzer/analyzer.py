from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
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


class TrajectoryStore(Protocol):
    def fetch_sessions(self, days: int, source: str | None, now: datetime) -> Sequence[Any]: ...

    def fetch_active_messages(
        self, days: int, source: str | None, now: datetime
    ) -> Sequence[Any]: ...


@dataclass(frozen=True)
class SessionRecord:
    id: str
    source: str | None
    title: str | None
    model: str | None
    parent_session_id: str | None
    system_prompt: str | None
    api_calls: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    reasoning_tokens: int


@dataclass(frozen=True)
class MessageRecord:
    session_id: str
    role: str


@dataclass(frozen=True)
class TurnRecord:
    session_id: str
    turn_index: int
    assistant_steps: int


class SqliteStore:
    """Two-query, bound-SQL reader for the persisted session schema."""

    _SESSION_FIELDS = (
        "id", "source", "title", "model", "parent_session_id", "system_prompt", "api_calls",
        "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
    )
    _SESSION_SELECT_FIELDS = (
        "id", "source", "title", "model", "parent_session_id", "system_prompt",
        "api_call_count AS api_calls", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "reasoning_tokens",
    )

    def __init__(self, connection):
        self._connection = connection

    def fetch_sessions(self, days: int, source: str | None, now: datetime):
        cutoff = (now - timedelta(days=days)).timestamp()
        columns = ", ".join(self._SESSION_SELECT_FIELDS)
        query = f"SELECT {columns} FROM sessions WHERE started_at >= ?"
        parameters: tuple[float, ...] | tuple[float, str] = (cutoff,)
        if source is not None:
            query += " AND source = ?"
            parameters = (cutoff, source)
        cursor = self._connection.execute(query, parameters)
        return [_row_dict(row, self._SESSION_FIELDS) for row in cursor]

    def fetch_active_messages(self, days: int, source: str | None, now: datetime):
        cutoff = (now - timedelta(days=days)).timestamp()
        query = (
            "SELECT m.session_id, m.role FROM messages AS m "
            "JOIN sessions AS s ON s.id = m.session_id "
            "WHERE m.active = 1 AND s.started_at >= ?"
        )
        parameters: tuple[float, ...] | tuple[float, str] = (cutoff,)
        if source is not None:
            query += " AND s.source = ?"
            parameters = (cutoff, source)
        cursor = self._connection.execute(query + " ORDER BY m.session_id, m.id", parameters)
        return [_row_dict(row, ("session_id", "role")) for row in cursor]


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
    findings.extend(_large_initial_prompt_findings(sessions, thresholds))
    findings.extend(_low_cache_reuse_findings(sessions, thresholds))
    findings.extend(_same_model_child_findings(sessions, thresholds))
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
            "estimated_avoidable_tokens": 0,
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
            records.append(
                SessionRecord(
                    session_id,
                    source if isinstance(source, str) else None,
                    _optional_text(row, "title"),
                    _optional_text(row, "model"),
                    _optional_text(row, "parent_session_id"),
                    _optional_text(row, "system_prompt"),
                    _nonnegative_int(row, "api_calls"),
                    _nonnegative_int(row, "input_tokens"),
                    _nonnegative_int(row, "output_tokens"),
                    _nonnegative_int(row, "cache_read_tokens"),
                    _nonnegative_int(row, "cache_write_tokens"),
                    _nonnegative_int(row, "reasoning_tokens"),
                )
            )
    return tuple(records)


def _messages(rows: Sequence[Any], session_ids: set[str]) -> tuple[MessageRecord, ...]:
    records = []
    for row in rows:
        session_id, role = _value(row, "session_id"), _value(row, "role")
        if (
            isinstance(session_id, str)
            and isinstance(role, str)
            and session_id in session_ids
            and role in {"user", "assistant"}
        ):
            records.append(MessageRecord(session_id, role))
    return tuple(records)


def _turns(messages: Sequence[MessageRecord], session_ids: Sequence[str]) -> tuple[TurnRecord, ...]:
    active: dict[str, int | None] = {session_id: None for session_id in session_ids}
    counts = {session_id: 0 for session_id in session_ids}
    turns: list[TurnRecord] = []
    for message in messages:
        if message.role == "user":
            counts[message.session_id] += 1
            turns.append(TurnRecord(message.session_id, counts[message.session_id], 0))
            active[message.session_id] = len(turns) - 1
        elif active[message.session_id] is not None:
            index = active[message.session_id]
            assert index is not None
            turn = turns[index]
            turns[index] = TurnRecord(turn.session_id, turn.turn_index, turn.assistant_steps + 1)
    return tuple(turns)


def _finding(turn: TurnRecord) -> dict[str, Any]:
    return {
        "code": "high_assistant_steps_per_turn",
        "severity": "high",
        "session_id": turn.session_id,
        "turn_index": turn.turn_index,
        "assistant_steps": turn.assistant_steps,
        "impact": {"kind": "measured_exposure", "assistant_steps": turn.assistant_steps},
    }


def _large_initial_prompt_findings(
    sessions: Sequence[SessionRecord], thresholds: AnalyzerThresholds
) -> list[dict[str, Any]]:
    findings = []
    for session in sessions:
        if session.system_prompt is None:
            continue
        prompt_bytes = len(session.system_prompt.encode("utf-8"))
        if prompt_bytes > thresholds.large_system_prompt_bytes and session.api_calls > 0:
            findings.append(
                {
                    "code": "large_initial_prompt",
                    "severity": "high",
                    "session_id": session.id,
                    "system_prompt_bytes": prompt_bytes,
                    "api_calls": session.api_calls,
                    "estimated_repeated_workload_tokens": math.ceil(prompt_bytes / 4)
                    * session.api_calls,
                    "workload_estimate_method": (
                        "ceil(system_prompt_utf8_bytes / 4) * api_call_count"
                    ),
                    "impact": {
                        "kind": "measured_exposure",
                        "caveat": (
                            "Estimated token workload uses UTF-8 bytes divided by four per API "
                            "call; cache and context behavior may reduce repeated provider exposure."
                        ),
                    },
                }
            )
    return findings


def _low_cache_reuse_findings(
    sessions: Sequence[SessionRecord], thresholds: AnalyzerThresholds
) -> list[dict[str, Any]]:
    findings = []
    for session in sessions:
        relevant_workload = session.input_tokens + session.cache_read_tokens
        if (
            session.api_calls > 1
            and relevant_workload >= thresholds.low_cache_reuse_min_workload_tokens
            and relevant_workload > 0
        ):
            ratio = session.cache_read_tokens / relevant_workload
            if ratio < thresholds.low_cache_reuse_ratio:
                findings.append(
                    {
                        "code": "low_cache_reuse",
                        "severity": "medium",
                        "session_id": session.id,
                        "api_calls": session.api_calls,
                        "relevant_workload_tokens": relevant_workload,
                        "observed_cache_reuse_ratio": ratio,
                        "impact": {"kind": "measured_exposure"},
                    }
                )
    return findings


def _same_model_child_findings(
    sessions: Sequence[SessionRecord], thresholds: AnalyzerThresholds
) -> list[dict[str, Any]]:
    by_id = {session.id: session for session in sessions}
    findings = []
    for child in sessions:
        if child.parent_session_id is None:
            continue
        parent = by_id.get(child.parent_session_id)
        if (
            parent is None
            or not child.model
            or child.model != parent.model
            or child.api_calls < thresholds.same_model_child_min_api_calls
            or _has_cyclic_parent(child, by_id)
        ):
            continue
        workload = _child_workload_tokens(child)
        findings.append(
            {
                "code": "same_model_subagent_exposure",
                "severity": "medium",
                "session_id": child.id,
                "parent_session_id": parent.id,
                "model": child.model,
                "api_calls": child.api_calls,
                "child_workload_tokens": workload,
                "impact": {
                    "kind": "benchmark_required",
                    "caveat": "Model routing requires a benchmark; exposure is not automatic savings.",
                },
            }
        )
    return findings


def _child_workload_tokens(session: SessionRecord) -> int:
    return (
        session.input_tokens
        + session.output_tokens
        + session.cache_read_tokens
        + session.cache_write_tokens
        + session.reasoning_tokens
    )


def _has_cyclic_parent(session: SessionRecord, by_id: dict[str, SessionRecord]) -> bool:
    visited = set()
    current = session
    while current.parent_session_id:
        if current.id in visited:
            return True
        visited.add(current.id)
        parent = by_id.get(current.parent_session_id)
        if parent is None:
            return False
        current = parent
    return False


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


def _optional_text(row: Any, field: str) -> str | None:
    value = _value(row, field)
    return value if isinstance(value, str) else None


def _nonnegative_int(row: Any, field: str) -> int:
    value = _value(row, field)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _row_dict(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if hasattr(row, "keys"):
        return dict(row)
    return dict(zip(fields, row))
