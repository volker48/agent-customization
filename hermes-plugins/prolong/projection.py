"""Private append/rebuild storage for Hermes PRO-LONG projections."""

from __future__ import annotations

import errno
import importlib
import json
import math
import os
import re
import stat
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .session_reader import _MESSAGE_FIELDS, _SESSION_FIELDS, _message_content_chunks


_PROJECTION_RECORD_TYPES = {
    "session_segment",
    "message",
    "message_content_chunk",
}
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")
_NULLABLE_MESSAGE_TEXT_FIELDS = (
    "api_content",
    "codex_message_items",
    "codex_reasoning_items",
    "effect_disposition",
    "finish_reason",
    "platform_message_id",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "tool_name",
)


@dataclass(frozen=True)
class FileSignature:
    device: int
    inode: int
    links: int
    size: int
    modified_ns: int
    changed_ns: int
    mode: int
    owner: int


@dataclass(frozen=True)
class SyncResult:
    mode: str
    record_count: int
    byte_size: int
    elapsed_ms: float


def _signature(metadata: os.stat_result) -> FileSignature:
    return FileSignature(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        links=metadata.st_nlink,
        size=metadata.st_size,
        modified_ns=metadata.st_mtime_ns,
        changed_ns=metadata.st_ctime_ns,
        mode=stat.S_IMODE(metadata.st_mode),
        owner=metadata.st_uid,
    )


def _same_captured_file(
    actual: FileSignature,
    expected: FileSignature,
) -> bool:
    """Compare an inode across a same-directory rename, which may change ctime."""
    return (
        actual.device == expected.device
        and actual.inode == expected.inode
        and actual.links == expected.links
        and actual.size == expected.size
        and actual.modified_ns == expected.modified_ns
        and actual.mode == expected.mode
        and actual.owner == expected.owner
    )


def _validate_regular_file(
    metadata: os.stat_result,
    *,
    expected_mode: int,
    label: str,
) -> None:
    owned_by_current_user = hasattr(os, "getuid") and metadata.st_uid == os.getuid()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or not owned_by_current_user
    ):
        raise RuntimeError(f"Refusing unsafe PRO-LONG log: {label}")


def _read_signature(
    path: Path,
    *,
    allow_private_writable: bool = False,
) -> FileSignature | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    expected_mode = (
        0o600
        if allow_private_writable and stat.S_IMODE(metadata.st_mode) == 0o600
        else 0o400
    )
    _validate_regular_file(metadata, expected_mode=expected_mode, label=str(path))
    return _signature(metadata)


def _serialize(record: Mapping[str, Any]) -> str:
    return json.dumps(
        record,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _finite_number(value: object) -> bool:
    if type(value) is int:
        return True
    if type(value) is float:
        return math.isfinite(value)
    return False


def _nullable_nonnegative_count(value: object) -> bool:
    return value is None or (type(value) is int and value >= 0)


def _valid_session_metadata(session: object) -> bool:
    if not isinstance(session, dict) or set(session) != set(_SESSION_FIELDS):
        return False
    session_id = session.get("id")
    parent_session_id = session.get("parent_session_id")
    return (
        type(session_id) is str
        and _SAFE_SESSION_ID.fullmatch(session_id) is not None
        and (
            parent_session_id is None
            or (
                type(parent_session_id) is str
                and _SAFE_SESSION_ID.fullmatch(parent_session_id) is not None
            )
        )
        and type(session.get("source")) is str
        and bool(session["source"])
        and _finite_number(session.get("started_at"))
        and (session.get("ended_at") is None or _finite_number(session.get("ended_at")))
        and (
            session.get("end_reason") is None or type(session.get("end_reason")) is str
        )
        and _nullable_nonnegative_count(session.get("compression_count"))
        and _nullable_nonnegative_count(session.get("rewind_count"))
    )


def _valid_message_metadata(message: object, *, session_id: str) -> bool:
    if not isinstance(message, dict) or set(message) != set(_MESSAGE_FIELDS):
        return False
    tool_call_id = message.get("tool_call_id")
    return (
        type(message.get("id")) is int
        and message["id"] > 0
        and type(message.get("session_id")) is str
        and message["session_id"] == session_id
        and _SAFE_SESSION_ID.fullmatch(message["session_id"]) is not None
        and type(message.get("role")) is str
        and bool(message["role"])
        and (
            message.get("tool_calls") is None
            or isinstance(message.get("tool_calls"), list)
        )
        and all(
            message.get(field) is None or type(message.get(field)) is str
            for field in _NULLABLE_MESSAGE_TEXT_FIELDS
        )
        and _finite_number(message.get("timestamp"))
        and _nullable_nonnegative_count(message.get("token_count"))
        and type(message.get("observed")) is int
        and message["observed"] in {0, 1}
        and type(message.get("active")) is int
        and message["active"] in {0, 1}
        and type(message.get("compacted")) is int
        and message["compacted"] in {0, 1}
        and (tool_call_id is None or type(tool_call_id) is str)
        and (
            message.get("display_kind") is None
            or type(message.get("display_kind")) is str
        )
        and (
            message.get("display_metadata") is None
            or isinstance(message.get("display_metadata"), dict)
        )
    )


def _valid_projection_record(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    lineage_index = record.get("lineage_index")
    if type(lineage_index) is not int or lineage_index < 0:
        return False
    record_type = record.get("record_type")
    if record_type not in _PROJECTION_RECORD_TYPES:
        return False
    if record_type == "session_segment":
        session = record.get("session")
        return set(record) == {
            "lineage_index",
            "record_type",
            "session",
        } and _valid_session_metadata(session)
    session_id = record.get("session_id")
    if type(session_id) is not str or _SAFE_SESSION_ID.fullmatch(session_id) is None:
        return False
    if record_type == "message":
        return set(record) == {
            "lineage_index",
            "message",
            "record_type",
            "session_id",
        } and _valid_message_metadata(record.get("message"), session_id=session_id)
    chunk_index = record.get("chunk_index")
    chunk_count = record.get("chunk_count")
    return (
        set(record)
        == {
            "chunk_count",
            "chunk_index",
            "content",
            "content_encoding",
            "lineage_index",
            "message_id",
            "record_type",
            "role",
            "session_id",
            "tool_call_id",
        }
        and type(chunk_index) is int
        and type(chunk_count) is int
        and 0 <= chunk_index < chunk_count
        and isinstance(record.get("content"), str)
    )


def _valid_projection_records(records: Sequence[dict[str, Any]]) -> bool:
    if not records:
        return False
    segment_ids: dict[int, str] = {}
    seen_session_ids: set[str] = set()
    root_parent_session_id: str | None = None
    current_lineage_index = -1
    expected_chunks: tuple[dict[str, Any], ...] = ()
    expected_chunk_index = 0
    last_message_id = 0

    for record in records:
        record_type = record["record_type"]
        if record_type != "message_content_chunk" and expected_chunk_index < len(
            expected_chunks
        ):
            return False
        lineage_index = record["lineage_index"]
        if record_type == "session_segment":
            if lineage_index != current_lineage_index + 1:
                return False
            session = record["session"]
            session_id = session["id"]
            if session_id in seen_session_ids:
                return False
            if (
                current_lineage_index >= 0
                and session["parent_session_id"] != segment_ids[current_lineage_index]
            ):
                return False
            segment_ids[lineage_index] = session_id
            seen_session_ids.add(session_id)
            if lineage_index == 0:
                root_parent_session_id = session["parent_session_id"]
            current_lineage_index = lineage_index
            expected_chunks = ()
            expected_chunk_index = 0
            last_message_id = 0
            continue
        if lineage_index != current_lineage_index or record.get(
            "session_id"
        ) != segment_ids.get(lineage_index):
            return False
        if record_type == "message":
            message = record["message"]
            if message["id"] <= last_message_id:
                return False
            last_message_id = message["id"]
            expected_chunks = _message_content_chunks(
                message,
                session_id=record["session_id"],
                lineage_index=lineage_index,
            )
            expected_chunk_index = 0
            continue
        if (
            expected_chunk_index >= len(expected_chunks)
            or record != expected_chunks[expected_chunk_index]
        ):
            return False
        expected_chunk_index += 1

    return (
        expected_chunk_index == len(expected_chunks)
        and bool(segment_ids)
        and (
            root_parent_session_id is None
            or root_parent_session_id not in seen_session_ids
        )
    )


def _jsonl(serialized: Sequence[str]) -> bytes:
    if not serialized:
        return b""
    return ("\n".join(serialized) + "\n").encode("utf-8")


def _open_flags(*flags: int) -> int:
    value = 0
    for flag in flags:
        value |= flag
    return value | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _write_all(descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("PRO-LONG write made no progress")
        remaining = remaining[written:]


def _validate_directory_ancestors(path: Path) -> None:
    absolute_path = path if path.is_absolute() else Path.cwd() / path
    for ancestor in absolute_path.parents:
        if ancestor.parent == ancestor:
            continue
        try:
            metadata = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"Refusing unsafe PRO-LONG directory: {ancestor}")


def _create_missing_directory_ancestors(path: Path) -> None:
    if path == Path(".") or path.parent == path:
        return
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        _create_missing_directory_ancestors(path.parent)
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            path.chmod(0o700)
        metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Refusing unsafe PRO-LONG directory: {path}")


def _ensure_private_directory(
    path: Path, *, strict_existing_mode: bool = False
) -> None:
    _validate_directory_ancestors(path)
    created = False
    try:
        path.mkdir(mode=0o700)
        created = True
    except FileNotFoundError:
        _create_missing_directory_ancestors(path.parent)
        try:
            path.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
    except FileExistsError:
        pass
    if created:
        path.chmod(0o700)
    metadata = path.lstat()
    owned_by_current_user = not hasattr(os, "getuid") or metadata.st_uid == os.getuid()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or not owned_by_current_user
        or (strict_existing_mode and stat.S_IMODE(metadata.st_mode) != 0o700)
    ):
        raise RuntimeError(f"Refusing unsafe PRO-LONG directory: {path}")


def _managed_projection_root_directories(root: Path) -> tuple[Path, ...]:
    if len(root.parents) > 1 and root.parents[1].name == "plugin-data":
        managed = [root.parents[1], root.parent, root]
        if len(root.parents) > 2 and root.parents[2] != Path("."):
            managed.insert(0, root.parents[2])
        return tuple(managed)
    return (root,)


def _managed_store_directories(directory: Path) -> tuple[Path, ...]:
    if len(directory.parents) > 2 and directory.parents[2].name == "plugin-data":
        managed = [
            directory.parents[2],
            directory.parents[1],
            directory.parent,
            directory,
        ]
        if len(directory.parents) > 3 and directory.parents[3] != Path("."):
            managed.insert(0, directory.parents[3])
        return tuple(managed)
    return (directory.parent, directory)


@contextmanager
def projection_root_transaction(projection_root: Path):
    """Serialize anchor selection and publication across plugin processes."""
    root = Path(projection_root)
    for path in _managed_projection_root_directories(root):
        _ensure_private_directory(path, strict_existing_mode=True)
    lock_path = root / ".prolong.lock"
    descriptor = os.open(
        lock_path,
        _open_flags(os.O_RDWR, os.O_CREAT),
        0o600,
    )
    try:
        _validate_regular_file(
            os.fstat(descriptor),
            expected_mode=0o600,
            label=str(lock_path),
        )
        fcntl_module = importlib.import_module("fcntl")
        fcntl_module.flock(descriptor, fcntl_module.LOCK_EX)
        try:
            yield
        finally:
            fcntl_module.flock(descriptor, fcntl_module.LOCK_UN)
    finally:
        os.close(descriptor)


def _ensure_private_lease_directory(path: Path) -> None:
    created = False
    try:
        path.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    if created:
        path.chmod(0o700)
    metadata = path.lstat()
    owned_by_current_user = not hasattr(os, "getuid") or metadata.st_uid == os.getuid()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or not owned_by_current_user
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise RuntimeError(f"Refusing unsafe PRO-LONG lease directory: {path}")


def projection_lease_path(projection_root: Path, anchor: str) -> Path:
    """Return the private lease file for one validated projection anchor."""
    if not anchor or Path(anchor).name != anchor or anchor in {".", ".."}:
        raise ValueError(f"unsafe PRO-LONG lease anchor: {anchor!r}")
    return Path(projection_root) / ".leases" / anchor


def acquire_projection_lease(
    projection_root: Path,
    anchor: str,
    *,
    exclusive: bool = False,
    nonblocking: bool = False,
) -> int | None:
    """Acquire one OS-managed anchor lease while the root transaction is held."""
    lease_path = projection_lease_path(projection_root, anchor)
    _ensure_private_lease_directory(lease_path.parent)
    descriptor = os.open(
        lease_path,
        _open_flags(os.O_RDWR, os.O_CREAT),
        0o600,
    )
    try:
        descriptor_metadata = os.fstat(descriptor)
        _validate_regular_file(
            descriptor_metadata,
            expected_mode=0o600,
            label=str(lease_path),
        )
        path_metadata = lease_path.lstat()
        _validate_regular_file(
            path_metadata,
            expected_mode=0o600,
            label=str(lease_path),
        )
        if (
            descriptor_metadata.st_dev != path_metadata.st_dev
            or descriptor_metadata.st_ino != path_metadata.st_ino
        ):
            raise RuntimeError(f"Refusing replaced PRO-LONG lease: {lease_path}")
        fcntl_module = importlib.import_module("fcntl")
        operation = fcntl_module.LOCK_EX if exclusive else fcntl_module.LOCK_SH
        if nonblocking:
            operation |= fcntl_module.LOCK_NB
        try:
            fcntl_module.flock(descriptor, operation)
        except BlockingIOError:
            if nonblocking:
                os.close(descriptor)
                return None
            raise
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def release_projection_lease(descriptor: int) -> None:
    """Release a controller lease; process death provides the same release guarantee."""
    try:
        fcntl_module = importlib.import_module("fcntl")
        fcntl_module.flock(descriptor, fcntl_module.LOCK_UN)
    finally:
        os.close(descriptor)


class ProjectionStore:
    """Maintain one integrity-checked, owner-private JSONL projection."""

    def __init__(self, log_path: Path) -> None:
        if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
            raise RuntimeError("PRO-LONG secure storage requires POSIX O_NOFOLLOW")
        self.log_path = Path(log_path)
        self.directory_path = self.log_path.parent
        self.process_lock_path = self.directory_path.parent / ".prolong.lock"
        self._records: tuple[str, ...] = ()
        self._source_records: Sequence[Mapping[str, Any]] | None = None
        self._expected_signature: FileSignature | None = None
        self._lock = threading.RLock()

    def sync(
        self,
        records: Sequence[Mapping[str, Any]],
        *,
        force_rebuild: bool = False,
        _process_lock_held: bool = False,
    ) -> SyncResult:
        started = time.monotonic_ns()
        if _process_lock_held:
            with self._lock:
                self._ensure_private_directories()
                return self._sync_locked(
                    records, force_rebuild=force_rebuild, started=started
                )
        with self.transaction():
            return self._sync_locked(
                records, force_rebuild=force_rebuild, started=started
            )

    def _sync_locked(
        self,
        records: Sequence[Mapping[str, Any]],
        *,
        force_rebuild: bool,
        started: int,
    ) -> SyncResult:
        actual_signature = _read_signature(
            self.log_path,
            allow_private_writable=True,
        )
        if (
            self._expected_signature is None
            and actual_signature is not None
            and actual_signature.mode == 0o400
        ):
            try:
                self._adopt_for_cleanup_locked()
            except RuntimeError:
                pass
            actual_signature = _read_signature(
                self.log_path,
                allow_private_writable=True,
            )
        if (
            not force_rebuild
            and isinstance(records, tuple)
            and records is self._source_records
            and actual_signature is not None
            and actual_signature == self._expected_signature
        ):
            return SyncResult(
                mode="noop",
                record_count=len(records),
                byte_size=actual_signature.size,
                elapsed_ms=(time.monotonic_ns() - started) / 1_000_000,
            )

        serialized = tuple(_serialize(record) for record in records)
        integrity_matches = (
            self._expected_signature is not None
            and actual_signature is not None
            and self._expected_signature == actual_signature
        )
        prefix_matches = (
            len(self._records) <= len(serialized)
            and serialized[: len(self._records)] == self._records
        )

        if not force_rebuild and integrity_matches and prefix_matches:
            if len(serialized) == len(self._records):
                mode = "noop"
                trusted_signature = actual_signature
            else:
                if actual_signature is None:
                    raise RuntimeError("PRO-LONG log disappeared before append")
                trusted_signature = self._append(
                    serialized[len(self._records) :],
                    actual_signature,
                )
                mode = "append"
        else:
            trusted_signature = self._rebuild(serialized)
            mode = "rebuild"

        synchronized_signature = _read_signature(self.log_path)
        if (
            synchronized_signature is None
            or synchronized_signature != trusted_signature
        ):
            raise RuntimeError("PRO-LONG log changed during synchronization")
        self._records = serialized
        self._source_records = records if isinstance(records, tuple) else None
        self._expected_signature = synchronized_signature
        return SyncResult(
            mode=mode,
            record_count=len(serialized),
            byte_size=synchronized_signature.size,
            elapsed_ms=(time.monotonic_ns() - started) / 1_000_000,
        )

    @contextmanager
    def transaction(self):
        """Serialize one canonical read plus projection mutation across processes."""
        with self._lock:
            self._ensure_private_directories()
            lock_descriptor, fcntl_module = self._acquire_process_lock()
            try:
                yield
            finally:
                fcntl_module.flock(lock_descriptor, fcntl_module.LOCK_UN)
                os.close(lock_descriptor)

    def cleanup(self, *, _process_lock_held: bool = False) -> None:
        """Delete this derived projection without touching the shared root."""
        if _process_lock_held:
            with self._lock:
                self._ensure_private_directories()
                self._cleanup_locked()
            return
        with self.transaction():
            self._cleanup_locked()

    def adopt_for_cleanup(
        self,
        *,
        allow_append_refresh: bool = False,
        _process_lock_held: bool = False,
    ) -> None:
        """Bind an inherited valid projection read-only before secure cleanup."""
        if _process_lock_held:
            with self._lock:
                self._ensure_private_directories()
                self._adopt_for_cleanup_locked(
                    allow_append_refresh=allow_append_refresh,
                )
            return
        with self.transaction():
            self._adopt_for_cleanup_locked(
                allow_append_refresh=allow_append_refresh,
            )

    def _adopt_for_cleanup_locked(self, *, allow_append_refresh: bool = False) -> None:
        previous_signature = self._expected_signature
        previous_records = self._records
        if previous_signature is not None and not allow_append_refresh:
            return
        if previous_signature is not None:
            actual_signature = _read_signature(
                self.log_path,
                allow_private_writable=True,
            )
            if actual_signature == previous_signature:
                return
        try:
            descriptor = os.open(self.log_path, _open_flags(os.O_RDONLY))
        except FileNotFoundError:
            if previous_signature is not None:
                raise RuntimeError(
                    f"Refusing changed PRO-LONG projection: {self.log_path}"
                ) from None
            self._records = ()
            self._source_records = None
            return
        except OSError as error:
            raise RuntimeError(
                f"Refusing unsafe PRO-LONG log: {self.log_path}"
            ) from error
        try:
            metadata = os.fstat(descriptor)
            mode = stat.S_IMODE(metadata.st_mode)
            if mode not in {0o400, 0o600}:
                raise RuntimeError(
                    f"Refusing invalid PRO-LONG projection: {self.log_path}"
                )
            _validate_regular_file(
                metadata,
                expected_mode=mode,
                label=str(self.log_path),
            )
            expected_signature = _signature(metadata)
            path_metadata = self.log_path.lstat()
            _validate_regular_file(
                path_metadata,
                expected_mode=mode,
                label=str(self.log_path),
            )
            if (
                path_metadata.st_dev != metadata.st_dev
                or path_metadata.st_ino != metadata.st_ino
            ):
                raise RuntimeError(
                    f"Refusing replaced PRO-LONG projection: {self.log_path}"
                )
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                payload = stream.read()
            if _signature(os.fstat(descriptor)) != expected_signature:
                raise RuntimeError(
                    f"Refusing changed PRO-LONG projection: {self.log_path}"
                )
            final_path_signature = _signature(self.log_path.lstat())
            if final_path_signature != expected_signature:
                raise RuntimeError(
                    f"Refusing changed PRO-LONG projection: {self.log_path}"
                )
        finally:
            os.close(descriptor)

        try:
            if payload and not payload.endswith(b"\n"):
                raise ValueError("projection lacks a final newline")
            serialized: list[str] = []
            parsed_records: list[dict[str, Any]] = []
            for raw_line in payload.splitlines():
                line = raw_line.decode("utf-8")
                record = json.loads(line)
                if not _valid_projection_record(record):
                    raise ValueError("projection has an unsupported record")
                if _serialize(record) != line:
                    raise ValueError("projection record is not canonical JSON")
                serialized.append(line)
                parsed_records.append(record)
            records = tuple(serialized)
            if not _valid_projection_records(parsed_records):
                raise ValueError("projection records are incoherent")
            if _jsonl(records) != payload:
                raise ValueError("projection is not canonical JSONL")
            if previous_signature is not None and (
                len(records) <= len(previous_records)
                or records[: len(previous_records)] != previous_records
            ):
                raise ValueError("projection is not an append-only extension")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(
                f"Refusing invalid PRO-LONG projection: {self.log_path}"
            ) from error

        self._records = records
        self._source_records = None
        self._expected_signature = expected_signature

    def _cleanup_locked(self) -> None:
        _ensure_private_directory(self.directory_path)
        temporary_paths = self._validated_private_temporary_files()
        actual_signature = self._validated_cleanup_signature()
        self._remove_private_temporary_files(temporary_paths)
        if self._validated_private_temporary_files():
            raise RuntimeError(
                f"Refusing changed PRO-LONG cleanup artifacts: {self.directory_path}"
            )
        if actual_signature is not None:
            deletion_signature = self._validated_cleanup_signature()
            if deletion_signature != actual_signature:
                raise RuntimeError(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                )
            self._capture_and_unlink(
                self.log_path,
                actual_signature,
                expected_payload=_jsonl(self._records),
                before_unlink=self._require_only_quarantined_log,
                error_message=(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                ),
            )
        try:
            self.directory_path.rmdir()
        except FileNotFoundError:
            pass
        except OSError as error:
            if error.errno != errno.ENOTEMPTY:
                raise
            raise RuntimeError(
                f"Refusing changed PRO-LONG cleanup artifacts: {self.directory_path}"
            ) from error
        self._records = ()
        self._source_records = None
        self._expected_signature = None

    def _validated_cleanup_signature(self) -> FileSignature | None:
        actual_signature = _read_signature(
            self.log_path,
            allow_private_writable=True,
        )
        if actual_signature is None:
            return None
        if self._expected_signature is None:
            raise RuntimeError(
                f"Refusing to remove changed PRO-LONG log: {self.log_path}"
            )
        if actual_signature == self._expected_signature:
            return actual_signature
        if actual_signature.mode != 0o600:
            raise RuntimeError(
                f"Refusing to remove changed PRO-LONG log: {self.log_path}"
            )

        descriptor = os.open(self.log_path, _open_flags(os.O_RDONLY))
        try:
            metadata = os.fstat(descriptor)
            _validate_regular_file(
                metadata,
                expected_mode=0o600,
                label=str(self.log_path),
            )
            if _signature(metadata) != actual_signature:
                raise RuntimeError(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                )
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                payload = stream.read()
            if payload != _jsonl(self._records):
                raise RuntimeError(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                )
            if _signature(os.fstat(descriptor)) != actual_signature:
                raise RuntimeError(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                )
            return actual_signature
        finally:
            os.close(descriptor)

    def _capture_and_unlink(
        self,
        path: Path,
        expected_signature: FileSignature,
        *,
        expected_payload: bytes | None = None,
        before_unlink: Callable[[Path], None] | None = None,
        error_message: str,
        allow_missing: bool = False,
    ) -> None:
        placeholder_descriptor, quarantine_name = tempfile.mkstemp(
            prefix=".prolong-cleanup-",
            suffix=".tmp",
            dir=self.directory_path,
        )
        quarantine_path = Path(quarantine_name)
        captured = False
        try:
            os.fchmod(placeholder_descriptor, 0o600)
        finally:
            os.close(placeholder_descriptor)
        try:
            try:
                os.replace(path, quarantine_path)
            except FileNotFoundError:
                if allow_missing:
                    return
                raise RuntimeError(error_message) from None
            captured = True
            try:
                metadata = quarantine_path.lstat()
                _validate_regular_file(
                    metadata,
                    expected_mode=expected_signature.mode,
                    label=str(quarantine_path),
                )
                if not _same_captured_file(_signature(metadata), expected_signature):
                    raise RuntimeError(error_message)
                if expected_payload is not None:
                    descriptor = os.open(
                        quarantine_path,
                        _open_flags(os.O_RDONLY),
                    )
                    try:
                        opened_signature = _signature(os.fstat(descriptor))
                        if not _same_captured_file(
                            opened_signature, expected_signature
                        ):
                            raise RuntimeError(error_message)
                        with os.fdopen(os.dup(descriptor), "rb") as stream:
                            if stream.read() != expected_payload:
                                raise RuntimeError(error_message)
                        if not _same_captured_file(
                            _signature(os.fstat(descriptor)), expected_signature
                        ):
                            raise RuntimeError(error_message)
                    finally:
                        os.close(descriptor)
            except Exception as error:
                try:
                    path.lstat()
                except FileNotFoundError:
                    os.replace(quarantine_path, path)
                raise RuntimeError(error_message) from error
            if before_unlink is not None:
                try:
                    before_unlink(quarantine_path)
                except Exception as error:
                    try:
                        path.lstat()
                    except FileNotFoundError:
                        os.replace(quarantine_path, path)
                    raise RuntimeError(error_message) from error
            quarantine_path.unlink()
        finally:
            if not captured:
                try:
                    quarantine_path.unlink()
                except FileNotFoundError:
                    pass

    def _require_only_quarantined_log(self, quarantine_path: Path) -> None:
        for path in self.directory_path.iterdir():
            if path != quarantine_path:
                raise RuntimeError(
                    f"Refusing changed PRO-LONG cleanup artifacts: {path}"
                )

    def _validated_private_temporary_files(
        self,
    ) -> tuple[tuple[Path, FileSignature], ...]:
        temporary_paths: list[tuple[Path, FileSignature]] = []
        for path in self.directory_path.iterdir():
            if path == self.log_path:
                continue
            trajectory_middle = path.name.removeprefix(".trajectory-").removesuffix(
                ".tmp"
            )
            quarantine_middle = path.name.removeprefix(
                ".prolong-cleanup-"
            ).removesuffix(".tmp")
            is_trajectory_temporary = (
                path.name.startswith(".trajectory-")
                and path.name.endswith(".tmp")
                and bool(trajectory_middle)
            )
            is_cleanup_quarantine = (
                path.name.startswith(".prolong-cleanup-")
                and path.name.endswith(".tmp")
                and bool(quarantine_middle)
            )
            if not (is_trajectory_temporary or is_cleanup_quarantine):
                raise RuntimeError(
                    f"Refusing unexpected PRO-LONG cleanup artifact: {path}"
                )
            metadata = path.lstat()
            mode = stat.S_IMODE(metadata.st_mode)
            if mode not in {0o400, 0o600}:
                raise RuntimeError(f"Refusing unsafe PRO-LONG cleanup artifact: {path}")
            _validate_regular_file(
                metadata,
                expected_mode=mode,
                label=str(path),
            )
            temporary_paths.append((path, _signature(metadata)))
        return tuple(temporary_paths)

    def _remove_private_temporary_files(
        self,
        temporary_paths: Sequence[tuple[Path, FileSignature]] | None = None,
    ) -> None:
        if temporary_paths is None:
            temporary_paths = self._validated_private_temporary_files()
        for path, expected_signature in temporary_paths:
            try:
                metadata = path.lstat()
                mode = stat.S_IMODE(metadata.st_mode)
                try:
                    _validate_regular_file(
                        metadata,
                        expected_mode=mode,
                        label=str(path),
                    )
                except RuntimeError as error:
                    raise RuntimeError(
                        f"Refusing unsafe PRO-LONG cleanup artifact: {path}"
                    ) from error
                if (
                    mode not in {0o400, 0o600}
                    or _signature(metadata) != expected_signature
                ):
                    raise RuntimeError(
                        f"Refusing unsafe PRO-LONG cleanup artifact: {path}"
                    )
                self._capture_and_unlink(
                    path,
                    expected_signature,
                    error_message=(
                        f"Refusing unsafe PRO-LONG cleanup artifact: {path}"
                    ),
                    allow_missing=True,
                )
            except FileNotFoundError:
                pass

    def _ensure_private_directories(self) -> None:
        for path in _managed_store_directories(self.directory_path):
            _ensure_private_directory(path, strict_existing_mode=True)

    def _acquire_process_lock(self) -> tuple[int, Any]:
        descriptor = os.open(
            self.process_lock_path,
            _open_flags(os.O_RDWR, os.O_CREAT),
            0o600,
        )
        try:
            _validate_regular_file(
                os.fstat(descriptor),
                expected_mode=0o600,
                label=str(self.process_lock_path),
            )
            fcntl_module = importlib.import_module("fcntl")
            fcntl_module.flock(descriptor, fcntl_module.LOCK_EX)
            return descriptor, fcntl_module
        except Exception:
            os.close(descriptor)
            raise

    def _append(
        self,
        suffix: Sequence[str],
        expected_signature: FileSignature,
    ) -> FileSignature:
        read_descriptor: int | None = None
        append_descriptor: int | None = None
        mode_needs_restore = False
        try:
            read_descriptor = os.open(
                self.log_path,
                _open_flags(os.O_RDONLY),
            )
            read_metadata = os.fstat(read_descriptor)
            _validate_regular_file(
                read_metadata,
                expected_mode=0o400,
                label=str(self.log_path),
            )
            if _signature(read_metadata) != expected_signature:
                raise RuntimeError("PRO-LONG log changed before append")
            mode_needs_restore = True
            os.fchmod(read_descriptor, 0o600)

            append_descriptor = os.open(
                self.log_path,
                _open_flags(os.O_WRONLY, os.O_APPEND),
            )
            append_metadata = os.fstat(append_descriptor)
            _validate_regular_file(
                append_metadata,
                expected_mode=0o600,
                label=str(self.log_path),
            )
            if (
                append_metadata.st_dev != read_metadata.st_dev
                or append_metadata.st_ino != read_metadata.st_ino
            ):
                raise RuntimeError("PRO-LONG log identity changed before append")

            _write_all(append_descriptor, _jsonl(suffix))
            os.fsync(append_descriptor)
            os.fchmod(append_descriptor, 0o400)
            mode_needs_restore = False
            final_metadata = os.fstat(append_descriptor)
            _validate_regular_file(
                final_metadata,
                expected_mode=0o400,
                label=str(self.log_path),
            )
            return _signature(final_metadata)
        finally:
            if append_descriptor is not None:
                os.close(append_descriptor)
            if read_descriptor is not None:
                try:
                    if mode_needs_restore:
                        os.fchmod(read_descriptor, 0o400)
                finally:
                    os.close(read_descriptor)

    def _rebuild(self, serialized: Sequence[str]) -> FileSignature:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".trajectory-",
            suffix=".tmp",
            dir=self.directory_path,
        )
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            payload = _jsonl(serialized)
            if payload:
                _write_all(descriptor, payload)
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o400)
            os.replace(temporary_path, self.log_path)
            directory_descriptor = os.open(
                self.directory_path,
                _open_flags(os.O_RDONLY, getattr(os, "O_DIRECTORY", 0)),
            )
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
            return _signature(os.fstat(descriptor))
        finally:
            os.close(descriptor)
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
