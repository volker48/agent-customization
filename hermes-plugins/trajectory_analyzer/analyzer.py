from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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


def analyze(
    store: TrajectoryStore,
    days: int = 30,
    source: str | None = None,
    now: datetime | None = None,
    thresholds: AnalyzerThresholds = DEFAULT_THRESHOLDS,
):
    generated_at = now or datetime.now(timezone.utc)
    sessions = _sessions(store.fetch_sessions(days, source, generated_at))
    session_ids = tuple(session.id for session in sessions)
    messages = _messages(store.fetch_active_messages(days, source, generated_at), set(session_ids))
    turns = _turns(messages, session_ids)
    findings = [
        _finding(turn)
        for turn in turns
        if turn.assistant_steps > thresholds.assistant_steps_per_turn
    ]
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
