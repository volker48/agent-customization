"""Private append/rebuild storage for Hermes PRO-LONG projections."""

from __future__ import annotations

import errno
import importlib
import json
import os
import stat
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


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


def _ensure_private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    metadata = path.lstat()
    owned_by_current_user = not hasattr(os, "getuid") or metadata.st_uid == os.getuid()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or not owned_by_current_user
    ):
        raise RuntimeError(f"Refusing unsafe PRO-LONG directory: {path}")
    path.chmod(0o700)


@contextmanager
def projection_root_transaction(projection_root: Path):
    """Serialize anchor selection and publication across plugin processes."""
    root = Path(projection_root)
    for path in reversed(root.parents[:2]):
        _ensure_private_directory(path)
    _ensure_private_directory(root)
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

    def _cleanup_locked(self) -> None:
        actual_signature = _read_signature(self.log_path)
        if actual_signature is not None:
            if (
                self._expected_signature is None
                or actual_signature != self._expected_signature
            ):
                raise RuntimeError(
                    f"Refusing to remove changed PRO-LONG log: {self.log_path}"
                )
            self.log_path.unlink()
        try:
            _ensure_private_directory(self.directory_path)
            self.directory_path.rmdir()
        except FileNotFoundError:
            pass
        except OSError as error:
            if error.errno != errno.ENOTEMPTY:
                raise
            self._remove_private_temporary_files()
            self.directory_path.rmdir()
        self._records = ()
        self._source_records = None
        self._expected_signature = None

    def _remove_private_temporary_files(self) -> None:
        temporary_paths: list[Path] = []
        for path in self.directory_path.iterdir():
            middle = path.name.removeprefix(".trajectory-").removesuffix(".tmp")
            if (
                not path.name.startswith(".trajectory-")
                or not path.name.endswith(".tmp")
                or not middle
            ):
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
            temporary_paths.append(path)
        for path in temporary_paths:
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def _ensure_private_directories(self) -> None:
        for path in reversed(self.directory_path.parents[:3]):
            _ensure_private_directory(path)
        _ensure_private_directory(self.directory_path)

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
