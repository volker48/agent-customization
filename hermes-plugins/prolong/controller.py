"""Hermes lifecycle adapter for PRO-LONG projection synchronization."""

from __future__ import annotations

import json
import logging
import os
import re
import stat
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .projection import ProjectionStore, SyncResult, projection_root_transaction
from .session_reader import HermesSessionReader

LOGGER = logging.getLogger("hermes.plugins.prolong")
_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")


def get_runtime_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()


def validate_session_id(session_id: str) -> str:
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError(f"unsafe Hermes session id: {session_id!r}")
    return session_id


def log_path_for(projection_root: Path, session_id: str) -> Path:
    safe_id = validate_session_id(session_id)
    return projection_root / safe_id / "trajectory.jsonl"


class ProlongController:
    """Synchronize canonical Hermes rows into one isolated lineage projection."""

    def __init__(
        self,
        *,
        reader: HermesSessionReader | None = None,
        hermes_home: Path | None = None,
        projection_root: Path | None = None,
    ) -> None:
        self._home = Path(hermes_home).expanduser() if hermes_home else None
        self._projection_root = (
            Path(projection_root).expanduser() if projection_root else None
        )
        db_path = self._home / "state.db" if self._home is not None else None
        self._reader = reader or HermesSessionReader(db_path=db_path)
        self._stores: dict[str, ProjectionStore] = {}
        self._snapshots: dict[str, Any] = {}
        self._session_roots: dict[str, str] = {}
        self._session_locks: dict[str, threading.RLock] = {}
        self._last_errors: dict[str, str] = {}
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._active_operations = 0
        self._retired_sessions: set[str] = set()
        self._startup_sweep_started = False
        self._maintenance = False
        self._closing = False
        self._closed = False

    def _runtime_home(self) -> Path:
        return self._home if self._home is not None else get_runtime_home()

    def _root(self) -> Path:
        if self._projection_root is not None:
            return self._projection_root
        return self._runtime_home() / "plugin-data" / "prolong" / "sessions"

    @contextmanager
    def _operation(self, session_id: str | None = None):
        with self._condition:
            while self._maintenance and not self._closing and not self._closed:
                self._condition.wait()
            if self._closing or self._closed:
                raise RuntimeError("PRO-LONG controller is closed")
            if session_id is not None and session_id in self._retired_sessions:
                raise RuntimeError(f"PRO-LONG session is finalized: {session_id}")
            self._active_operations += 1
        try:
            yield
        finally:
            with self._condition:
                self._active_operations -= 1
                if self._active_operations == 0:
                    self._condition.notify_all()

    def _session_lock(self, root_session_id: str) -> threading.RLock:
        with self._lock:
            lock = self._session_locks.get(root_session_id)
            if lock is None:
                lock = threading.RLock()
                self._session_locks[root_session_id] = lock
            return lock

    def _store_for(self, root_session_id: str) -> ProjectionStore:
        with self._lock:
            store = self._stores.get(root_session_id)
            if store is None:
                store = ProjectionStore(log_path_for(self._root(), root_session_id))
                self._stores[root_session_id] = store
            return store

    def _lineage_root(self, session_id: str) -> tuple[str, tuple[str, ...]]:
        lineage = tuple(self._reader.lineage(session_id)) or (session_id,)
        root_session_id = validate_session_id(lineage[0])
        return root_session_id, lineage

    def _find_projection_anchor(
        self,
        session_id: str,
        lineage: tuple[str, ...],
    ) -> str | None:
        root = self._root()
        try:
            root_metadata = root.lstat()
        except FileNotFoundError:
            return None
        if (
            not stat.S_ISDIR(root_metadata.st_mode)
            or root_metadata.st_uid != os.getuid()
        ):
            raise RuntimeError(f"unsafe PRO-LONG projection root: {root}")
        exact: list[tuple[int, str]] = []
        compatible: list[tuple[int, str]] = []
        for directory in sorted(root.iterdir(), key=lambda path: path.name):
            try:
                metadata = directory.lstat()
                anchor = validate_session_id(directory.name)
            except (OSError, ValueError):
                continue
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700
            ):
                continue
            try:
                segments = self._projection_segments(directory / "trajectory.jsonl")
                if session_id in segments:
                    exact.append((len(segments), anchor))
                elif segments and lineage[: len(segments)] == segments:
                    compatible.append((len(segments), anchor))
            except (FileNotFoundError, RuntimeError, json.JSONDecodeError):
                continue
        for _, anchor in exact:
            if anchor == session_id:
                return anchor
        candidates = exact or compatible
        return max(candidates, default=(0, ""))[1] or None

    def _projection_root_for(
        self,
        session_id: str,
        canonical_root: str,
        lineage: tuple[str, ...],
    ) -> str:
        with self._lock:
            known_root = self._session_roots.get(session_id)
        if known_root is not None:
            return known_root
        existing_anchor = self._find_projection_anchor(session_id, lineage)
        if existing_anchor is not None:
            return existing_anchor
        canonical_log = log_path_for(self._root(), canonical_root)
        try:
            canonical_log.lstat()
        except FileNotFoundError:
            return canonical_root
        return session_id if session_id != canonical_root else canonical_root

    def projection_path(self, session_id: str) -> Path:
        """Synchronize and resolve the stable path rendered into the system prompt."""
        safe_id = validate_session_id(session_id)
        try:
            with self._operation(safe_id):
                try:
                    self._synchronize_admitted(safe_id)
                    with self._lock:
                        root_session_id = self._session_roots[safe_id]
                except Exception:
                    LOGGER.exception(
                        "PRO-LONG could not synchronize projection path for %s; "
                        "using its stable fallback path",
                        safe_id,
                    )
                    with self._lock:
                        root_session_id = self._session_roots.setdefault(
                            safe_id, safe_id
                        )
                return log_path_for(self._root(), root_session_id)
        except Exception:
            LOGGER.exception(
                "PRO-LONG controller rejected projection path admission for %s; "
                "using an unregistered tip path",
                safe_id,
            )
            return log_path_for(self._root(), safe_id)

    def synchronize(
        self,
        session_id: str,
        *,
        force_rebuild: bool = False,
    ) -> SyncResult:
        safe_id = validate_session_id(session_id)
        with self._operation(safe_id):
            return self._synchronize_admitted(
                safe_id,
                force_rebuild=force_rebuild,
            )

    def _synchronize_admitted(
        self,
        safe_id: str,
        *,
        force_rebuild: bool = False,
    ) -> SyncResult:
        canonical_root, lineage = self._lineage_root(safe_id)
        with projection_root_transaction(self._root()):
            root_session_id = self._projection_root_for(
                safe_id,
                canonical_root,
                lineage,
            )
            lock = self._session_lock(root_session_id)
            with lock:
                store = self._store_for(root_session_id)
                with self._lock:
                    previous = self._snapshots.get(root_session_id)
                snapshot = self._reader.snapshot(safe_id, previous=previous)
                if not snapshot.lineage:
                    raise RuntimeError("PRO-LONG snapshot had no compression lineage")
                validate_session_id(snapshot.lineage[0])
                result = store.sync(
                    snapshot.records,
                    force_rebuild=force_rebuild,
                    _process_lock_held=True,
                )
                with self._lock:
                    self._snapshots[root_session_id] = snapshot
                    self._session_roots[safe_id] = root_session_id
                    self._last_errors.pop(safe_id, None)
                return result

    def _resolve_cleanup_root(self, session_id: str) -> str:
        with self._lock:
            known_root = self._session_roots.get(session_id)
        if known_root is not None:
            return known_root
        try:
            canonical_root, lineage = self._lineage_root(session_id)
            return self._projection_root_for(session_id, canonical_root, lineage)
        except Exception:
            return session_id

    def cleanup(self, session_id: str) -> None:
        safe_id = validate_session_id(session_id)
        retiring_ids = {safe_id}
        with self._condition:
            while self._maintenance and not self._closing and not self._closed:
                self._condition.wait()
            if self._closing or self._closed:
                raise RuntimeError("PRO-LONG controller is closed")
            self._maintenance = True
            while self._active_operations:
                self._condition.wait()
        try:
            with projection_root_transaction(self._root()):
                root_session_id = self._resolve_cleanup_root(safe_id)
                with self._lock:
                    retiring_ids.add(root_session_id)
                    retiring_ids.update(
                        segment_id
                        for segment_id, projection_root in self._session_roots.items()
                        if projection_root == root_session_id
                    )
                lock = self._session_lock(root_session_id)
                with lock:
                    with self._lock:
                        store = self._stores.get(root_session_id)
                    if store is None:
                        log_path = log_path_for(self._root(), root_session_id)
                        try:
                            log_path.parent.lstat()
                        except FileNotFoundError:
                            pass
                        else:
                            store = self._store_for(root_session_id)
                            store.sync(
                                (),
                                force_rebuild=True,
                                _process_lock_held=True,
                            )
                    if store is not None:
                        store.cleanup(_process_lock_held=True)
                    with self._lock:
                        self._stores.pop(root_session_id, None)
                        self._snapshots.pop(root_session_id, None)
                        self._session_locks.pop(root_session_id, None)
                        self._session_roots = {
                            segment_id: projection_root
                            for segment_id, projection_root in self._session_roots.items()
                            if projection_root != root_session_id
                        }
        finally:
            with self._condition:
                self._retired_sessions.update(retiring_ids)
                self._maintenance = False
                self._condition.notify_all()

    def _projection_segments(self, log_path: Path) -> tuple[str, ...]:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
        descriptor = os.open(log_path, flags)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or metadata.st_nlink != 1
                or stat.S_IMODE(metadata.st_mode) != 0o400
            ):
                raise RuntimeError(f"unsafe PRO-LONG log during sweep: {log_path}")
            with os.fdopen(os.dup(descriptor), encoding="utf-8") as stream:
                records = (json.loads(line) for line in stream if line.strip())
                return tuple(
                    validate_session_id(str(record["session"]["id"]))
                    for record in records
                    if record.get("record_type") == "session_segment"
                )
        finally:
            os.close(descriptor)

    def sweep_orphans(self) -> int:
        """Remove projections whose persisted lineage was directly deleted."""
        removed = 0
        with self._operation():
            root = self._root()
            try:
                root.lstat()
            except FileNotFoundError:
                return 0
            with projection_root_transaction(root):
                root_metadata = root.lstat()
                if (
                    not stat.S_ISDIR(root_metadata.st_mode)
                    or root_metadata.st_uid != os.getuid()
                ):
                    raise RuntimeError(f"unsafe PRO-LONG projection root: {root}")
                for directory in tuple(root.iterdir()):
                    try:
                        metadata = directory.lstat()
                        root_session_id = validate_session_id(directory.name)
                    except (OSError, ValueError):
                        continue
                    if (
                        not stat.S_ISDIR(metadata.st_mode)
                        or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) != 0o700
                    ):
                        continue
                    log_path = directory / "trajectory.jsonl"
                    try:
                        segments = self._projection_segments(log_path)
                        orphaned = bool(segments) and not any(
                            self._reader.session_exists(segment_id)
                            for segment_id in segments
                        )
                        if not orphaned:
                            continue
                        lock = self._session_lock(root_session_id)
                        with lock:
                            store = self._store_for(root_session_id)
                            store.sync(
                                (),
                                force_rebuild=True,
                                _process_lock_held=True,
                            )
                            store.cleanup(_process_lock_held=True)
                            with self._lock:
                                self._stores.pop(root_session_id, None)
                                self._snapshots.pop(root_session_id, None)
                                self._session_locks.pop(root_session_id, None)
                                self._session_roots = {
                                    segment_id: projection_root
                                    for segment_id, projection_root in self._session_roots.items()
                                    if projection_root != root_session_id
                                }
                        removed += 1
                    except FileNotFoundError:
                        continue
                    except Exception:
                        LOGGER.exception(
                            "PRO-LONG orphan sweep failed for %s", directory
                        )
        return removed

    def _safe_synchronize(self, hook_name: str, session_id: str) -> None:
        try:
            self.synchronize(session_id)
        except Exception as exc:
            with self._lock:
                self._last_errors[session_id] = f"{hook_name}: {exc}"
            LOGGER.exception(
                "PRO-LONG %s synchronization failed for %s", hook_name, session_id
            )

    def _safe_cleanup(self, hook_name: str, session_id: str) -> None:
        try:
            self.cleanup(session_id)
        except Exception:
            LOGGER.exception("PRO-LONG %s cleanup failed for %s", hook_name, session_id)

    def on_session_start(self, *, session_id: str, **_: Any) -> None:
        safe_id = validate_session_id(session_id)
        with self._condition:
            while self._maintenance and not self._closing and not self._closed:
                self._condition.wait()
            self._retired_sessions.discard(safe_id)
            run_startup_sweep = not self._startup_sweep_started
            self._startup_sweep_started = True
        if run_startup_sweep:
            try:
                self.sweep_orphans()
            except Exception:
                LOGGER.exception("PRO-LONG startup orphan sweep failed")
        self._safe_synchronize("on_session_start", safe_id)
        return None

    def pre_llm_call(self, *, session_id: str, **_: Any) -> dict[str, str] | None:
        self._safe_synchronize("pre_llm_call", session_id)
        with self._lock:
            error = self._last_errors.get(session_id)
        if error is None:
            return None
        return {
            "context_type": "prolong_sync_warning",
            "context": (
                "PRO-LONG programmatic memory may not be current because its most "
                f"recent synchronization failed ({error}). Treat the JSONL as stale."
            ),
        }

    def pre_tool_call(self, *, session_id: str, **_: Any) -> None:
        self._safe_synchronize("pre_tool_call", session_id)
        return None

    def post_llm_call(self, *, session_id: str, **_: Any) -> None:
        self._safe_synchronize("post_llm_call", session_id)
        return None

    def on_session_end(self, *, session_id: str, **_: Any) -> None:
        self._safe_synchronize("on_session_end", session_id)
        return None

    def on_session_finalize(self, *, session_id: str, **_: Any) -> None:
        self._safe_cleanup("on_session_finalize", session_id)
        return None

    def on_session_reset(self, *, session_id: str, **kwargs: Any) -> None:
        old_session_id = kwargs.get("old_session_id") or kwargs.get(
            "previous_session_id"
        )
        if isinstance(old_session_id, str) and old_session_id:
            self._safe_cleanup("on_session_reset", old_session_id)
        return None

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closing = True
            self._condition.notify_all()
            while self._active_operations or self._maintenance:
                self._condition.wait()
            stores = list(self._stores.items())
            self._stores.clear()
            self._snapshots.clear()
            self._session_roots.clear()
            self._session_locks.clear()
            self._last_errors.clear()
            self._retired_sessions.clear()
            self._closed = True

        for root_session_id, store in stores:
            try:
                store.cleanup()
            except Exception:
                LOGGER.exception(
                    "PRO-LONG unload cleanup failed for %s", root_session_id
                )
        self._reader.close()
