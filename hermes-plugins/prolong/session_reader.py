"""Read complete Hermes compression lineages from the canonical session store."""

from __future__ import annotations

import importlib
import json
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping


_SESSION_FIELDS = (
    "id",
    "parent_session_id",
    "source",
    "started_at",
    "ended_at",
    "end_reason",
    "compression_count",
    "rewind_count",
)
_MESSAGE_FIELDS = (
    "id",
    "session_id",
    "role",
    "content",
    "tool_call_id",
    "tool_calls",
    "tool_name",
    "effect_disposition",
    "timestamp",
    "token_count",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
    "platform_message_id",
    "observed",
    "active",
    "compacted",
    "api_content",
    "display_kind",
    "display_metadata",
)
_CONTENT_CHUNK_CHARS = 700
_CONTENT_CHUNK_OVERLAP = 200


@dataclass(frozen=True)
class SegmentState:
    session_id: str
    marker: dict[str, Any]
    last_message_id: int | None
    last_message: dict[str, Any] | None


@dataclass(frozen=True)
class SessionSnapshot:
    lineage: tuple[str, ...]
    records: tuple[dict[str, Any], ...]
    message_count: int
    max_message_id: int | None
    segment_states: tuple[SegmentState, ...]
    source_version: int | None


@contextmanager
def _consistent_read(database: Any):
    connection = getattr(database, "_conn", None)
    if connection is None:
        yield
        return
    owns_transaction = not connection.in_transaction
    if owns_transaction:
        connection.execute("BEGIN")
    try:
        yield
    finally:
        if owns_transaction and connection.in_transaction:
            connection.rollback()


def _source_version(database: Any) -> int | None:
    connection = getattr(database, "_conn", None)
    if connection is None:
        return None
    row = connection.execute("PRAGMA data_version").fetchone()
    return int(row[0]) if row is not None else None


def _default_db_factory(db_path: Path | None = None):
    session_db = getattr(importlib.import_module("hermes_state"), "SessionDB")
    return session_db(db_path=db_path, read_only=True)


def _segment_record(session: Mapping[str, Any], lineage_index: int) -> dict[str, Any]:
    return {
        "record_type": "session_segment",
        "lineage_index": lineage_index,
        "session": {field: session.get(field) for field in _SESSION_FIELDS},
    }


def _message_record(
    message: Mapping[str, Any],
    *,
    session_id: str,
    lineage_index: int,
) -> dict[str, Any]:
    unexpected_fields = set(message) - set(_MESSAGE_FIELDS)
    if unexpected_fields:
        raise RuntimeError(
            "unsupported persisted message fields: "
            + ", ".join(sorted(unexpected_fields))
        )
    return {
        "record_type": "message",
        "lineage_index": lineage_index,
        "session_id": session_id,
        "message": {field: message.get(field) for field in _MESSAGE_FIELDS},
    }


def _message_content_chunks(
    message: Mapping[str, Any],
    *,
    session_id: str,
    lineage_index: int,
) -> tuple[dict[str, Any], ...]:
    content = message.get("content")
    if isinstance(content, str):
        text = content
        encoding = "text"
    elif content is None:
        return ()
    else:
        text = json.dumps(
            content,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        encoding = "json"
    if len(text) <= _CONTENT_CHUNK_CHARS:
        return ()

    step = _CONTENT_CHUNK_CHARS - _CONTENT_CHUNK_OVERLAP
    contents: list[str] = []
    for start in range(0, len(text), step):
        contents.append(text[start : start + _CONTENT_CHUNK_CHARS])
        if start + _CONTENT_CHUNK_CHARS >= len(text):
            break
    chunk_count = len(contents)
    return tuple(
        {
            "record_type": "message_content_chunk",
            "lineage_index": lineage_index,
            "session_id": session_id,
            "message_id": message.get("id"),
            "role": message.get("role"),
            "tool_call_id": message.get("tool_call_id"),
            "content_encoding": encoding,
            "chunk_index": chunk_index,
            "chunk_count": chunk_count,
            "content": chunk,
        }
        for chunk_index, chunk in enumerate(contents)
    )


def _belongs_to_active_trajectory(message: Mapping[str, Any]) -> bool:
    return bool(message.get("active") or message.get("compacted"))


class HermesSessionReader:
    """Lazy, read-only adapter over Hermes's canonical ``SessionDB``."""

    def __init__(
        self,
        db_factory: Callable[[], Any] | None = None,
        *,
        db_path: Path | None = None,
    ) -> None:
        self._db_factory = db_factory or (lambda: _default_db_factory(db_path))
        self._database: Any | None = None
        self._lock = threading.RLock()

    def _db(self) -> Any:
        with self._lock:
            if self._database is None:
                self._database = self._db_factory()
            database = self._database
        if database is None:
            raise RuntimeError("Hermes session database factory returned None")
        return database

    def lineage(self, session_id: str) -> tuple[str, ...]:
        with self._lock:
            database = self._db()
            with _consistent_read(database):
                return tuple(database.get_compression_lineage(session_id)) or (
                    session_id,
                )

    def session_exists(self, session_id: str) -> bool:
        with self._lock:
            database = self._db()
            with _consistent_read(database):
                return database.get_session(session_id) is not None

    def snapshot(
        self,
        session_id: str,
        *,
        previous: SessionSnapshot | None = None,
    ) -> SessionSnapshot:
        with self._lock:
            database = self._db()
            with _consistent_read(database):
                source_version = _source_version(database)
                lineage = tuple(database.get_compression_lineage(session_id)) or (
                    session_id,
                )
                if (
                    previous is not None
                    and previous.lineage == lineage
                    and source_version is not None
                    and previous.source_version == source_version
                ):
                    return previous
                if (
                    previous is None
                    or previous.lineage != lineage
                    or source_version is not None
                ):
                    return self._full_snapshot(
                        database,
                        lineage,
                        source_version=source_version,
                    )
                return self._incremental_snapshot(database, lineage, previous)

    def _full_snapshot(
        self,
        database: Any,
        lineage: tuple[str, ...],
        *,
        source_version: int | None = None,
    ) -> SessionSnapshot:
        records: list[dict[str, Any]] = []
        segment_states: list[SegmentState] = []
        message_count = 0
        max_message_id: int | None = None
        for lineage_index, segment_id in enumerate(lineage):
            session = database.get_session(segment_id)
            if not session:
                raise LookupError(f"Hermes session segment not found: {segment_id}")
            marker = _segment_record(session, lineage_index)
            records.append(marker)
            last_message_id: int | None = None
            last_message: dict[str, Any] | None = None
            messages = database.get_messages(segment_id, include_inactive=True)
            for message in messages:
                if not _belongs_to_active_trajectory(message):
                    continue
                normalized_message = dict(message)
                records.append(
                    _message_record(
                        normalized_message,
                        session_id=segment_id,
                        lineage_index=lineage_index,
                    )
                )
                records.extend(
                    _message_content_chunks(
                        normalized_message,
                        session_id=segment_id,
                        lineage_index=lineage_index,
                    )
                )
                message_count += 1
                message_id = normalized_message.get("id")
                if isinstance(message_id, int):
                    last_message_id = message_id
                    max_message_id = (
                        message_id
                        if max_message_id is None
                        else max(max_message_id, message_id)
                    )
                last_message = normalized_message
            segment_states.append(
                SegmentState(
                    session_id=segment_id,
                    marker=marker,
                    last_message_id=last_message_id,
                    last_message=last_message,
                )
            )

        return SessionSnapshot(
            lineage=lineage,
            records=tuple(records),
            message_count=message_count,
            max_message_id=max_message_id,
            segment_states=tuple(segment_states),
            source_version=source_version,
        )

    def _incremental_snapshot(
        self,
        database: Any,
        lineage: tuple[str, ...],
        previous: SessionSnapshot,
    ) -> SessionSnapshot:
        records = list(previous.records)
        segment_states = list(previous.segment_states)
        message_count = previous.message_count
        max_message_id = previous.max_message_id
        changed = False

        for lineage_index, (segment_id, prior_state) in enumerate(
            zip(lineage, previous.segment_states, strict=True)
        ):
            session = database.get_session(segment_id)
            if not session:
                raise LookupError(f"Hermes session segment not found: {segment_id}")
            marker = _segment_record(session, lineage_index)
            if marker != prior_state.marker:
                return self._full_snapshot(
                    database,
                    lineage,
                    source_version=previous.source_version,
                )

            last_id = prior_state.last_message_id
            if last_id is None:
                messages = database.get_messages(segment_id, include_inactive=True)
                if messages:
                    return self._full_snapshot(
                        database,
                        lineage,
                        source_version=previous.source_version,
                    )
                continue

            tail_and_suffix = database.get_messages(
                segment_id,
                include_inactive=True,
                after_id=max(0, last_id - 1),
            )
            if not tail_and_suffix or tail_and_suffix[0].get("id") != last_id:
                return self._full_snapshot(
                    database,
                    lineage,
                    source_version=previous.source_version,
                )
            current_tail = dict(tail_and_suffix[0])
            if current_tail != prior_state.last_message:
                return self._full_snapshot(
                    database,
                    lineage,
                    source_version=previous.source_version,
                )

            suffix = [
                dict(message)
                for message in tail_and_suffix[1:]
                if _belongs_to_active_trajectory(message)
            ]
            if not suffix:
                continue
            if lineage_index != len(lineage) - 1:
                return self._full_snapshot(
                    database,
                    lineage,
                    source_version=previous.source_version,
                )

            for message in suffix:
                records.append(
                    _message_record(
                        message,
                        session_id=segment_id,
                        lineage_index=lineage_index,
                    )
                )
                records.extend(
                    _message_content_chunks(
                        message,
                        session_id=segment_id,
                        lineage_index=lineage_index,
                    )
                )
                message_count += 1
                message_id = message.get("id")
                if isinstance(message_id, int):
                    last_id = message_id
                    max_message_id = (
                        message_id
                        if max_message_id is None
                        else max(max_message_id, message_id)
                    )
            segment_states[lineage_index] = SegmentState(
                session_id=segment_id,
                marker=marker,
                last_message_id=last_id,
                last_message=suffix[-1],
            )
            changed = True

        if not changed:
            return previous
        return SessionSnapshot(
            lineage=lineage,
            records=tuple(records),
            message_count=message_count,
            max_message_id=max_message_id,
            segment_states=tuple(segment_states),
            source_version=previous.source_version,
        )

    def close(self) -> None:
        with self._lock:
            database, self._database = self._database, None
        if database is not None:
            database.close()
