from __future__ import annotations

import importlib
import json
import multiprocessing
import os
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from tests.hermes_prolong.test_plugin_registration import PLUGIN_DIR, load_plugin_module


def create_private_anchor(root: Path, anchor: str = "s1") -> Path:
    anchor_directory = root / anchor
    for path in (root.parent.parent, root.parent, root, anchor_directory):
        path.mkdir(mode=0o700, exist_ok=True)
        path.chmod(0o700)
    return anchor_directory


def canonical_session(session_id: str, parent_session_id: str | None = None) -> dict:
    return {
        "id": session_id,
        "parent_session_id": parent_session_id,
        "source": "test",
        "started_at": 1.0,
        "ended_at": None,
        "end_reason": None,
        "compression_count": 0,
        "rewind_count": 0,
    }


def canonical_message(message_id: int, session_id: str, content: str) -> dict:
    return {
        "id": message_id,
        "session_id": session_id,
        "role": "user",
        "content": content,
        "tool_call_id": None,
        "tool_calls": None,
        "tool_name": None,
        "effect_disposition": None,
        "timestamp": float(message_id),
        "token_count": None,
        "finish_reason": None,
        "reasoning": None,
        "reasoning_content": None,
        "reasoning_details": None,
        "codex_reasoning_items": None,
        "codex_message_items": None,
        "platform_message_id": None,
        "observed": 0,
        "active": 1,
        "compacted": 0,
        "api_content": None,
        "display_kind": None,
        "display_metadata": None,
    }


def canonical_segment_line(session_id: str, lineage_index: int = 0) -> str:
    return (
        json.dumps(
            {
                "lineage_index": lineage_index,
                "record_type": "session_segment",
                "session": canonical_session(session_id),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    )


class FakeReader:
    def __init__(self) -> None:
        self.closed = False
        self.previous_values: list[object | None] = []
        self.returned: list[object] = []
        self.records = [
            {
                "record_type": "session_segment",
                "lineage_index": 0,
                "session": canonical_session("s1"),
            },
            {
                "record_type": "message",
                "lineage_index": 0,
                "session_id": "s1",
                "message": canonical_message(1, "s1", "nonce"),
            },
        ]

    def snapshot(self, session_id: str, *, previous=None):
        if session_id != "s1":
            raise AssertionError(f"unexpected session id: {session_id}")
        self.previous_values.append(previous)
        snapshot = SimpleNamespace(records=tuple(self.records), lineage=("s1",))
        self.returned.append(snapshot)
        return snapshot

    def lineage(self, session_id: str):
        if session_id != "s1":
            raise AssertionError(f"unexpected session id: {session_id}")
        return ("s1",)

    def close(self) -> None:
        self.closed = True


class FailingReader:
    def lineage(self, session_id: str):
        return (session_id,)

    def snapshot(self, session_id: str, *, previous=None):
        del previous
        raise OSError(f"database unavailable for {session_id}")

    def close(self) -> None:
        return None


class MultiSessionReader:
    def __init__(self) -> None:
        self.failing_sessions: set[str] = set()

    def lineage(self, session_id: str):
        return (session_id,)

    def snapshot(self, session_id: str, *, previous=None):
        del previous
        if session_id in self.failing_sessions:
            raise OSError(f"database unavailable for {session_id}")
        return SimpleNamespace(
            records=(
                {
                    "record_type": "session_segment",
                    "lineage_index": 0,
                    "session": canonical_session(session_id),
                },
            ),
            lineage=(session_id,),
        )

    def close(self) -> None:
        return None


class RotatingReader:
    def __init__(self) -> None:
        self.closed = False
        self.existing = {"root", "tip"}

    def lineage(self, session_id: str):
        if session_id == "tip" and "root" in self.existing:
            return ("root", "tip")
        return (session_id,)

    def snapshot(self, session_id: str, *, previous=None):
        del previous
        lineage = self.lineage(session_id)
        records = [
            {
                "record_type": "session_segment",
                "lineage_index": index,
                "session": canonical_session(
                    segment_id,
                    lineage[index - 1] if index else None,
                ),
            }
            for index, segment_id in enumerate(lineage)
        ]
        records.append(
            {
                "record_type": "message",
                "lineage_index": len(lineage) - 1,
                "session_id": session_id,
                "message": canonical_message(
                    len(lineage),
                    session_id,
                    session_id,
                ),
            }
        )
        return SimpleNamespace(records=tuple(records), lineage=lineage)

    def session_exists(self, session_id: str) -> bool:
        return session_id in self.existing

    def close(self) -> None:
        self.closed = True


class ForkingReader:
    def __init__(self) -> None:
        self.existing = {"root", "branch-a", "branch-b"}

    def lineage(self, session_id: str):
        if session_id == "root":
            return ("root",)
        return ("root", session_id)

    def snapshot(self, session_id: str, *, previous=None):
        del previous
        lineage = self.lineage(session_id)
        records = [
            {
                "record_type": "session_segment",
                "lineage_index": index,
                "session": canonical_session(
                    segment_id,
                    lineage[index - 1] if index else None,
                ),
            }
            for index, segment_id in enumerate(lineage)
        ]
        records.append(
            {
                "record_type": "message",
                "lineage_index": len(lineage) - 1,
                "session_id": session_id,
                "message": canonical_message(
                    len(lineage),
                    session_id,
                    session_id,
                ),
            }
        )
        return SimpleNamespace(records=tuple(records), lineage=lineage)

    def session_exists(self, session_id: str) -> bool:
        return session_id in self.existing

    def close(self) -> None:
        return None


class BlockingReader(FakeReader):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def snapshot(self, session_id: str, *, previous=None):
        self.entered.set()
        if not self.release.wait(timeout=5):
            raise TimeoutError("test did not release blocking reader")
        return super().snapshot(session_id, previous=previous)


class BlockingLineageReader(FakeReader):
    def __init__(self) -> None:
        super().__init__()
        self.block_next_lineage = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def lineage(self, session_id: str):
        if self.block_next_lineage:
            self.block_next_lineage = False
            self.entered.set()
            if not self.release.wait(timeout=5):
                raise TimeoutError("test did not release blocking lineage read")
        return super().lineage(session_id)


class LockCheckingReader(FakeReader):
    def __init__(self, lock_path: Path) -> None:
        super().__init__()
        self.lock_path = lock_path
        self.snapshot_ran_under_process_lock = False

    def snapshot(self, session_id: str, *, previous=None):
        import fcntl

        descriptor = os.open(self.lock_path, os.O_RDWR)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.snapshot_ran_under_process_lock = True
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)
        return super().snapshot(session_id, previous=previous)


class ProlongControllerTests(unittest.TestCase):
    def test_sync_errors_are_keyed_and_cleared_by_session_id(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = MultiSessionReader()
        reader.failing_sessions.update(("s1", "s2"))

        with tempfile.TemporaryDirectory() as directory:
            controller = module.ProlongController(
                reader=reader,
                projection_root=(
                    Path(directory) / "plugin-data" / "prolong" / "sessions"
                ),
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller._safe_synchronize("pre_tool_call", "s1")
                controller._safe_synchronize("pre_tool_call", "s2")
            self.assertEqual(set(controller._last_errors), {"s1", "s2"})

            reader.failing_sessions.remove("s2")
            controller._safe_synchronize("pre_tool_call", "s2")

            self.assertEqual(set(controller._last_errors), {"s1"})
            self.assertIn("database unavailable for s1", controller._last_errors["s1"])
            with self.assertNoLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

    def test_concurrent_session_starts_sweep_once_and_synchronize_every_session(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = MultiSessionReader()
        session_ids = tuple(f"s{index}" for index in range(6))

        with tempfile.TemporaryDirectory() as directory:
            controller = module.ProlongController(
                reader=reader,
                projection_root=(
                    Path(directory) / "plugin-data" / "prolong" / "sessions"
                ),
            )
            sweep_started = threading.Event()
            release_sweep = threading.Event()
            start_barrier = threading.Barrier(len(session_ids) + 1)
            calls_lock = threading.Lock()
            sweep_calls = 0
            synchronized: list[str] = []

            def blocking_sweep() -> int:
                nonlocal sweep_calls
                with calls_lock:
                    sweep_calls += 1
                sweep_started.set()
                if not release_sweep.wait(timeout=5):
                    raise TimeoutError("test did not release startup sweep")
                return 0

            def record_synchronize(hook_name: str, session_id: str) -> None:
                self.assertEqual(hook_name, "on_session_start")
                with calls_lock:
                    synchronized.append(session_id)

            controller.sweep_orphans = blocking_sweep
            controller._safe_synchronize = record_synchronize

            def start_session(session_id: str) -> None:
                start_barrier.wait(timeout=5)
                controller.on_session_start(session_id=session_id)

            threads = [
                threading.Thread(target=start_session, args=(session_id,))
                for session_id in session_ids
            ]
            for thread in threads:
                thread.start()
            start_barrier.wait(timeout=5)
            self.assertTrue(sweep_started.wait(timeout=2))
            time.sleep(0.05)
            release_sweep.set()
            for thread in threads:
                thread.join(timeout=2)

            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(sweep_calls, 1)
            self.assertEqual(set(synchronized), set(session_ids))
            controller.close()

    def test_failed_startup_orphan_sweep_is_retried_by_a_later_session(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = MultiSessionReader()

        with tempfile.TemporaryDirectory() as directory:
            controller = module.ProlongController(
                reader=reader,
                projection_root=(
                    Path(directory) / "plugin-data" / "prolong" / "sessions"
                ),
            )
            sweep_calls = 0
            synchronized: list[str] = []

            def flaky_sweep() -> int:
                nonlocal sweep_calls
                sweep_calls += 1
                if sweep_calls == 1:
                    raise OSError("temporary sweep failure")
                return 0

            def record_synchronize(hook_name: str, session_id: str) -> None:
                self.assertEqual(hook_name, "on_session_start")
                synchronized.append(session_id)

            controller.sweep_orphans = flaky_sweep
            controller._safe_synchronize = record_synchronize

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.on_session_start(session_id="s1")
            controller.on_session_start(session_id="s2")

            self.assertEqual(sweep_calls, 2)
            self.assertEqual(synchronized, ["s1", "s2"])
            controller.close()

    def test_overlapping_session_start_retries_a_failed_startup_sweep(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = MultiSessionReader()
        session_ids = tuple(f"s{index}" for index in range(6))

        with tempfile.TemporaryDirectory() as directory:
            controller = module.ProlongController(
                reader=reader,
                projection_root=(
                    Path(directory) / "plugin-data" / "prolong" / "sessions"
                ),
            )
            first_sweep_entered = threading.Event()
            release_first_sweep = threading.Event()
            start_barrier = threading.Barrier(len(session_ids) + 1)
            calls_lock = threading.Lock()
            sweep_calls = 0
            synchronized: list[str] = []

            def fail_once_sweep() -> int:
                nonlocal sweep_calls
                with calls_lock:
                    sweep_calls += 1
                    call_number = sweep_calls
                if call_number == 1:
                    first_sweep_entered.set()
                    if not release_first_sweep.wait(timeout=5):
                        raise TimeoutError("test did not release failed sweep")
                    raise OSError("temporary sweep failure")
                return 0

            def record_synchronize(hook_name: str, session_id: str) -> None:
                self.assertEqual(hook_name, "on_session_start")
                with calls_lock:
                    synchronized.append(session_id)

            controller.sweep_orphans = fail_once_sweep
            controller._safe_synchronize = record_synchronize

            def start_session(session_id: str) -> None:
                start_barrier.wait(timeout=5)
                controller.on_session_start(session_id=session_id)

            threads = [
                threading.Thread(target=start_session, args=(session_id,))
                for session_id in session_ids
            ]
            for thread in threads:
                thread.start()
            start_barrier.wait(timeout=5)
            self.assertTrue(first_sweep_entered.wait(timeout=2))
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                release_first_sweep.set()
                for thread in threads:
                    thread.join(timeout=2)

            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(sweep_calls, 2)
            self.assertEqual(set(synchronized), set(session_ids))
            controller.close()

    def test_hooks_synchronize_and_lifecycle_cleanup_the_session_projection(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "controller.py"
        self.assertTrue(module_path.is_file(), f"controller is missing: {module_path}")
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = FakeReader()

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            projection_root = home / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=reader,
                hermes_home=home,
                projection_root=projection_root,
            )
            log_path = (
                home
                / "plugin-data"
                / "prolong"
                / "sessions"
                / "s1"
                / "trajectory.jsonl"
            )

            self.assertIsNone(
                controller.pre_llm_call(
                    session_id="s1",
                    message="current turn",
                    conversation_history=[],
                    unknown_future_field=True,
                )
            )
            first = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(first[-1]["message"]["content"], "nonce")

            reader.records.append(
                {
                    "record_type": "message",
                    "lineage_index": 0,
                    "session_id": "s1",
                    "message": canonical_message(2, "s1", "current turn"),
                }
            )
            self.assertIsNone(
                controller.pre_tool_call(
                    tool_name="read_file",
                    tool_args={"path": str(log_path)},
                    session_id="s1",
                    unknown_future_field=True,
                )
            )
            second = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(second[-1]["message"]["id"], 2)
            self.assertIsNone(reader.previous_values[0])
            self.assertIs(reader.previous_values[1], reader.returned[0])

            controller.on_session_finalize(
                session_id="s1", reason="reset", unknown=True
            )
            self.assertFalse(log_path.parent.exists())

            controller.close()
            self.assertTrue(reader.closed)

    def test_rotation_keeps_one_root_projection_and_tip_finalization_removes_it(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)

            controller.synchronize("root")
            controller.synchronize("tip")

            root_log = root / "root" / "trajectory.jsonl"
            tip_log = root / "tip" / "trajectory.jsonl"
            records = [
                json.loads(line)
                for line in root_log.read_text(encoding="utf-8").splitlines()
            ]
            self.assertFalse(tip_log.exists())
            self.assertEqual(records[-1]["message"]["content"], "tip")

            controller.on_session_finalize(session_id="tip")
            self.assertFalse(root_log.parent.exists())
            controller.close()

    def test_forked_compression_lineages_use_distinct_stable_projections(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = ForkingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            first = module.ProlongController(reader=reader, projection_root=root)
            second = module.ProlongController(reader=reader, projection_root=root)

            self.assertEqual(
                first.projection_path("branch-a"), root / "root" / "trajectory.jsonl"
            )
            self.assertEqual(
                second.projection_path("branch-b"),
                root / "branch-b" / "trajectory.jsonl",
            )
            self.assertIn(
                "branch-a",
                (root / "root" / "trajectory.jsonl").read_text(encoding="utf-8"),
            )
            self.assertIn(
                "branch-b",
                (root / "branch-b" / "trajectory.jsonl").read_text(encoding="utf-8"),
            )
            first.synchronize("branch-a")
            second.synchronize("branch-b")

            branch_a_path = first.projection_path("branch-a")
            branch_b_path = second.projection_path("branch-b")
            self.assertEqual(branch_a_path, root / "root" / "trajectory.jsonl")
            self.assertEqual(branch_b_path, root / "branch-b" / "trajectory.jsonl")
            self.assertNotEqual(branch_a_path, branch_b_path)
            self.assertIn("branch-a", branch_a_path.read_text(encoding="utf-8"))
            self.assertNotIn("branch-b", branch_a_path.read_text(encoding="utf-8"))
            self.assertIn("branch-b", branch_b_path.read_text(encoding="utf-8"))
            self.assertNotIn("branch-a", branch_b_path.read_text(encoding="utf-8"))

            first.synchronize("branch-a")
            self.assertEqual(first.projection_path("branch-a"), branch_a_path)
            self.assertEqual(second.projection_path("branch-b"), branch_b_path)
            self.assertIn("branch-b", branch_b_path.read_text(encoding="utf-8"))

            first.close()
            second.close()

    def test_resumed_ancestor_does_not_overwrite_live_descendant_projection(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            tip_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            resumed_root_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )

            tip_path = tip_controller.projection_path("tip")
            tip_bytes = tip_path.read_bytes()
            resumed_root_path = resumed_root_controller.projection_path("root")

            self.assertNotEqual(resumed_root_path, tip_path)
            self.assertTrue(resumed_root_path.is_file())
            self.assertEqual(tip_path.read_bytes(), tip_bytes)
            self.assertIn('"id":"tip"', tip_bytes.decode())
            self.assertNotIn(
                '"id":"tip"',
                resumed_root_path.read_text(encoding="utf-8"),
            )

            resumed_root_peer = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            self.assertEqual(
                resumed_root_peer.projection_path("root"),
                resumed_root_path,
            )
            resumed_root_peer.close()
            self.assertTrue(resumed_root_path.is_file())

            resumed_root_controller.close()
            self.assertFalse(resumed_root_path.parent.exists())
            self.assertEqual(tip_path.read_bytes(), tip_bytes)
            tip_controller.close()
            self.assertFalse(tip_path.parent.exists())

    def test_descendant_does_not_overwrite_live_resumed_ancestor_projection(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            ancestor_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            descendant_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )

            ancestor_path = ancestor_controller.projection_path("root")
            ancestor_bytes = ancestor_path.read_bytes()
            descendant_path = descendant_controller.projection_path("tip")

            self.assertNotEqual(descendant_path, ancestor_path)
            self.assertEqual(ancestor_path.read_bytes(), ancestor_bytes)
            self.assertNotIn('"id":"tip"', ancestor_bytes.decode())
            self.assertIn(
                '"id":"tip"',
                descendant_path.read_text(encoding="utf-8"),
            )

            descendant_controller.close()
            self.assertFalse(descendant_path.parent.exists())
            self.assertEqual(ancestor_path.read_bytes(), ancestor_bytes)
            ancestor_controller.close()
            self.assertFalse(ancestor_path.parent.exists())

    def test_descendant_does_not_overwrite_same_controller_advertised_ancestor(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )

            ancestor_path = controller.projection_path("root")
            ancestor_bytes = ancestor_path.read_bytes()
            descendant_path = controller.projection_path("tip")

            self.assertNotEqual(descendant_path, ancestor_path)
            self.assertEqual(ancestor_path.read_bytes(), ancestor_bytes)
            self.assertIn(
                '"id":"tip"',
                descendant_path.read_text(encoding="utf-8"),
            )
            controller.close()
            self.assertFalse(ancestor_path.parent.exists())
            self.assertFalse(descendant_path.parent.exists())

    def test_foreign_advertiser_blocks_locally_synchronized_prefix_reuse(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            rotating_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            foreign_advertiser = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )

            rotating_controller.synchronize("root")
            advertised_path = foreign_advertiser.projection_path("root")
            advertised_bytes = advertised_path.read_bytes()
            rotating_controller.synchronize("tip")
            tip_path = rotating_controller.projection_path("tip")

            self.assertNotEqual(tip_path, advertised_path)
            self.assertEqual(advertised_path.read_bytes(), advertised_bytes)
            self.assertIn('"id":"tip"', tip_path.read_text(encoding="utf-8"))

            rotating_controller.close()
            self.assertEqual(advertised_path.read_bytes(), advertised_bytes)
            foreign_advertiser.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_descendant_avoids_fileless_advertised_ancestor_fallback(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")

        class FailingResumedReader(RotatingReader):
            def snapshot(self, session_id: str, *, previous=None):
                if session_id == "root":
                    raise OSError("resumed snapshot unavailable")
                return super().snapshot(session_id, previous=previous)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            resumed_controller = module.ProlongController(
                reader=FailingResumedReader(),
                projection_root=root,
            )
            descendant_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )

            fallback_path = resumed_controller.projection_path("root")
            self.assertFalse(fallback_path.is_file())
            descendant_path = descendant_controller.projection_path("tip")

            self.assertNotEqual(descendant_path, fallback_path)
            self.assertFalse(fallback_path.is_file())
            self.assertIn(
                '"id":"tip"',
                descendant_path.read_text(encoding="utf-8"),
            )

            descendant_controller.close()
            self.assertFalse(descendant_path.parent.exists())
            resumed_controller.close()
            self.assertFalse(fallback_path.parent.exists())

    def test_failed_resumed_ancestor_uses_isolated_fallback_anchor(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")

        class FailingResumedReader(RotatingReader):
            def snapshot(self, session_id: str, *, previous=None):
                if session_id == "root":
                    raise OSError("resumed snapshot unavailable")
                return super().snapshot(session_id, previous=previous)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            tip_controller = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            resumed_controller = module.ProlongController(
                reader=FailingResumedReader(),
                projection_root=root,
            )

            tip_path = tip_controller.projection_path("tip")
            tip_bytes = tip_path.read_bytes()
            fallback_path = resumed_controller.projection_path("root")

            self.assertNotEqual(fallback_path, tip_path)
            self.assertNotIn(".unavailable", fallback_path.parts)
            self.assertEqual(tip_path.read_bytes(), tip_bytes)
            self.assertFalse(fallback_path.is_file())

            resumed_controller.close()
            self.assertEqual(tip_path.read_bytes(), tip_bytes)
            tip_controller.close()
            self.assertFalse(tip_path.parent.exists())

    def test_shared_projection_survives_first_controller_close_until_last_lease(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            controller_b = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            advertised_path = controller_a.projection_path("s1")
            self.assertEqual(controller_b.projection_path("s1"), advertised_path)

            controller_b.close()

            self.assertTrue(advertised_path.is_file())
            self.assertEqual(controller_a.projection_path("s1"), advertised_path)

            controller_a.close()

            self.assertFalse(advertised_path.parent.exists())

    def test_last_controller_close_adopts_a_sibling_append_before_cleanup(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            reader_a = FakeReader()
            reader_b = FakeReader()
            controller_a = module.ProlongController(
                reader=reader_a, projection_root=root
            )
            controller_b = module.ProlongController(
                reader=reader_b, projection_root=root
            )

            advertised_path = controller_a.projection_path("s1")
            self.assertEqual(controller_b.projection_path("s1"), advertised_path)
            reader_b.records.append(
                {
                    "lineage_index": 0,
                    "message": canonical_message(2, "s1", "sibling append"),
                    "record_type": "message",
                    "session_id": "s1",
                }
            )
            self.assertEqual(controller_b.synchronize("s1").mode, "append")

            controller_b.close()
            self.assertTrue(advertised_path.is_file())
            controller_a.close()

            self.assertFalse(advertised_path.parent.exists())

    def test_shared_projection_survives_sibling_session_finalization(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            controller_b = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            advertised_path = controller_a.projection_path("s1")
            self.assertEqual(controller_b.projection_path("s1"), advertised_path)

            controller_b.on_session_finalize(session_id="s1")

            self.assertTrue(advertised_path.is_file())
            self.assertEqual(controller_a.projection_path("s1"), advertised_path)

            controller_a.close()
            controller_b.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_projection_path_fallback_reserves_the_tip_path_for_recovery(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = ForkingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            real_synchronize = controller._synchronize_admitted

            def fail_synchronization(*_, **__):
                raise OSError("projection lock unavailable")

            controller._synchronize_admitted = fail_synchronization
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                fallback_path = controller.projection_path("branch-a")
            controller._synchronize_admitted = real_synchronize

            controller.synchronize("branch-a")
            recovered_path = controller.projection_path("branch-a")

            self.assertEqual(fallback_path, root / "branch-a" / "trajectory.jsonl")
            self.assertEqual(recovered_path, fallback_path)
            self.assertIn("branch-a", fallback_path.read_text(encoding="utf-8"))
            self.assertFalse((root / "root").exists())
            controller.close()

    def test_projection_path_fallback_holds_a_shared_lease_until_close(self) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        reader = FakeReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            advertised_path = root / "s1" / "trajectory.jsonl"
            projection_module.ProjectionStore(advertised_path).sync(reader.records)
            advertiser = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )
            sweeper = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )

            def fail_synchronization(*_, **__):
                raise OSError("projection lock unavailable")

            advertiser._synchronize_admitted = fail_synchronization
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                self.assertEqual(advertiser.projection_path("s1"), advertised_path)

            sweeper.close()
            self.assertTrue(advertised_path.is_file())

            advertiser.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_projection_path_never_advertises_an_unleased_real_fallback(self) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        reader = FakeReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            real_path = root / "s1" / "trajectory.jsonl"
            projection_module.ProjectionStore(real_path).sync(reader.records)
            advertiser = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )
            sweeper = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )

            def fail(*_, **__):
                raise OSError("lease unavailable")

            advertiser._synchronize_admitted = fail
            advertiser._acquire_anchor_lease = fail
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                unavailable_path = advertiser.projection_path("s1")

            self.assertNotEqual(unavailable_path, real_path)
            self.assertIn(".unavailable", unavailable_path.parts)
            self.assertFalse(unavailable_path.exists())
            sweeper.close()
            self.assertFalse(real_path.parent.exists())
            advertiser.close()

    def test_snapshot_and_projection_update_share_the_process_lock(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            lock_path = root / ".prolong.lock"
            reader = LockCheckingReader(lock_path)
            controller = module.ProlongController(reader=reader, projection_root=root)

            controller.synchronize("s1")

            self.assertTrue(reader.snapshot_ran_under_process_lock)
            controller.close()

    def test_orphan_sweep_retains_surviving_lineage_but_removes_fully_deleted_one(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            controller.synchronize("tip")
            root_log = root / "root" / "trajectory.jsonl"
            self.assertTrue(root_log.exists())

            reader.existing.remove("tip")
            self.assertEqual(controller.sweep_orphans(), 0)
            self.assertTrue(root_log.exists())
            surviving_records = [
                json.loads(line)
                for line in root_log.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(
                [
                    record["session"]["id"]
                    for record in surviving_records
                    if record["record_type"] == "session_segment"
                ],
                ["root"],
            )
            self.assertNotIn("tip", json.dumps(surviving_records, sort_keys=True))

            reader.existing.clear()
            self.assertEqual(controller.sweep_orphans(), 1)

            self.assertFalse(root_log.parent.exists())
            controller.close()

    def test_orphan_sweep_does_not_delete_a_sibling_advertised_projection(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(reader=reader, projection_root=root)
            controller_b = module.ProlongController(reader=reader, projection_root=root)
            advertised_path = controller_a.projection_path("tip")
            reader.existing.clear()

            self.assertEqual(controller_b.sweep_orphans(), 0)

            self.assertTrue(advertised_path.is_file())
            controller_b.close()
            self.assertTrue(advertised_path.is_file())
            controller_a.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_orphan_sweeper_reacquires_its_lease_when_sibling_blocks_cleanup(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(reader=reader, projection_root=root)
            controller_b = module.ProlongController(reader=reader, projection_root=root)
            advertised_path = controller_a.projection_path("tip")
            self.assertEqual(controller_b.projection_path("tip"), advertised_path)
            reader.existing.clear()

            self.assertEqual(controller_a.sweep_orphans(), 0)
            controller_b.close()

            self.assertTrue(advertised_path.is_file())
            controller_a.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_orphan_sweeper_restores_its_lease_when_cleanup_fails_closed(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader_a = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(
                reader=reader_a,
                projection_root=root,
            )
            advertised_path = controller_a.projection_path("tip")
            store = controller_a._stores["root"]
            real_cleanup = store.cleanup

            def fail_closed_cleanup(*args, **kwargs) -> None:
                raise RuntimeError("unsafe cleanup artifact")

            store.cleanup = fail_closed_cleanup
            reader_a.existing.clear()

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                self.assertEqual(controller_a.sweep_orphans(), 0)
            self.assertTrue(advertised_path.is_file())
            store.cleanup = real_cleanup

            controller_b = module.ProlongController(
                reader=RotatingReader(),
                projection_root=root,
            )
            self.assertEqual(controller_b.projection_path("tip"), advertised_path)
            controller_b.close()

            self.assertTrue(advertised_path.is_file())
            controller_a.close()
            self.assertFalse(advertised_path.parent.exists())

    def test_orphan_sweep_preserves_cleanup_error_when_lease_restore_fails(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            advertised_path = controller.projection_path("tip")
            store = controller._stores["root"]

            def fail_closed_cleanup(*args, **kwargs) -> None:
                raise ValueError("original unsafe cleanup artifact")

            def fail_lease_restore(root_session_id: str) -> None:
                raise RuntimeError(f"restore failed for {root_session_id}")

            store.cleanup = fail_closed_cleanup
            controller._acquire_anchor_lease = fail_lease_restore
            reader.existing.clear()

            with self.assertLogs("hermes.plugins.prolong", level="ERROR") as captured:
                self.assertEqual(controller.sweep_orphans(), 0)

            orphan_failure = next(
                record
                for record in captured.records
                if "orphan sweep failed" in record.getMessage()
            )
            self.assertIsNotNone(orphan_failure.exc_info)
            if orphan_failure.exc_info is None:
                self.fail("orphan failure log omitted exception information")
            self.assertIsInstance(orphan_failure.exc_info[1], ValueError)
            self.assertTrue(advertised_path.is_file())

    def test_finalize_preserves_a_locally_changed_projection_fail_closed(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            log_path = controller.projection_path("s1")
            changed_payload = '{"record_type":"foreign","same":"size"}\n'
            log_path.chmod(0o600)
            log_path.write_text(changed_payload, encoding="utf-8")
            log_path.chmod(0o400)

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.on_session_finalize(session_id="s1")

            self.assertEqual(log_path.read_text(encoding="utf-8"), changed_payload)
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

    def test_cold_close_refuses_malformed_private_projection_content(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        malformed_payloads = (
            b"",
            b"not-jsonl\n",
            b'{"lineage_index":0,"message":{"id":1},'
            b'"record_type":"message","session_id":"s1"}\n',
        )
        for payload in malformed_payloads:
            with (
                self.subTest(payload=payload),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory) / "plugin-data" / "prolong" / "sessions"
                log_path = root / "s1" / "trajectory.jsonl"
                create_private_anchor(root)
                log_path.write_bytes(payload)
                log_path.chmod(0o400)
                controller = module.ProlongController(
                    reader=FakeReader(),
                    projection_root=root,
                )

                with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                    controller.close()

                self.assertEqual(log_path.read_bytes(), payload)

    def test_orphan_sweep_takes_root_transaction_before_anchor_lock(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            create_private_anchor(root)
            log_path.write_text(canonical_segment_line("s1"), encoding="utf-8")
            log_path.chmod(0o400)
            controller = module.ProlongController(reader=reader, projection_root=root)
            transaction_active = False
            events: list[str] = []

            class TrackingTransaction:
                def __enter__(self):
                    nonlocal transaction_active
                    transaction_active = True
                    events.append("transaction-enter")

                def __exit__(self, *_):
                    nonlocal transaction_active
                    events.append("transaction-exit")
                    transaction_active = False

            class TrackingAnchorLock:
                def __enter__(self):
                    events.append(f"anchor-enter:{transaction_active}")

                def __exit__(self, *_):
                    events.append("anchor-exit")

            class TrackingStore:
                def adopt_for_cleanup(
                    self,
                    *,
                    allow_append_refresh=False,
                    _process_lock_held=False,
                ):
                    if not allow_append_refresh:
                        raise AssertionError("cleanup did not request append refresh")
                    events.append(f"adopt:{transaction_active}:{_process_lock_held}")

                def cleanup(self, *, _process_lock_held=False):
                    events.append(f"delete:{transaction_active}:{_process_lock_held}")

            store = TrackingStore()
            original_transaction = getattr(module, "projection_root_transaction")

            def tracking_transaction(projection_root: Path):
                self.assertEqual(projection_root, root)
                return TrackingTransaction()

            setattr(module, "projection_root_transaction", tracking_transaction)
            controller._session_lock = lambda root_session_id: TrackingAnchorLock()
            controller._store_for = lambda root_session_id: store
            try:
                removed = controller.sweep_orphans()
            finally:
                setattr(module, "projection_root_transaction", original_transaction)

            self.assertEqual(removed, 1)
            self.assertEqual(
                events,
                [
                    "transaction-enter",
                    "anchor-enter:True",
                    "adopt:True:True",
                    "delete:True:True",
                    "anchor-exit",
                    "transaction-exit",
                ],
            )
            controller.close()

    def test_deleted_ancestor_keeps_the_frozen_root_path_for_surviving_tip(
        self,
    ) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        reader = RotatingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            frozen_log = root / "root" / "trajectory.jsonl"
            snapshot = reader.snapshot("tip")
            projection_module.ProjectionStore(frozen_log).sync(snapshot.records)

            reader.existing.remove("root")
            controller = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )

            self.assertEqual(controller.projection_path("tip"), frozen_log)
            controller.synchronize("tip")

            self.assertTrue(frozen_log.exists())
            self.assertFalse((root / "tip").exists())
            records = [
                json.loads(line)
                for line in frozen_log.read_text(encoding="utf-8").splitlines()
            ]
            segments = [
                record["session"]["id"]
                for record in records
                if record.get("record_type") == "session_segment"
            ]
            self.assertEqual(segments, ["tip"])
            controller.on_session_finalize(session_id="tip")
            self.assertFalse(frozen_log.parent.exists())
            controller.close()

    def test_cold_finalize_adopts_and_removes_an_existing_projection(self) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        reader = FakeReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            projection_module.ProjectionStore(log_path).sync(tuple(reader.records))
            controller = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )

            controller.on_session_finalize(session_id="s1")

            self.assertFalse(log_path.parent.exists())
            controller.close()

    def test_unopened_controller_close_does_not_create_a_projection_root(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            controller.close()

            self.assertFalse(root.exists())

    def test_cold_close_discovers_and_removes_a_surviving_session_projection(
        self,
    ) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        reader = FakeReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            projection_module.ProjectionStore(log_path).sync(tuple(reader.records))
            controller = controller_module.ProlongController(
                reader=reader,
                projection_root=root,
            )

            controller.close()

            self.assertFalse(log_path.parent.exists())
            self.assertTrue(reader.closed)

    def test_crashed_controller_lease_fd_releases_for_cold_close(self) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        if "fork" not in multiprocessing.get_all_start_methods():
            self.skipTest("requires multiprocessing fork context")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            context = multiprocessing.get_context("fork")
            ready_receiver, ready_sender = context.Pipe(duplex=False)

            def publish_then_crash() -> None:
                controller = controller_module.ProlongController(
                    reader=FakeReader(),
                    projection_root=root,
                )
                controller.synchronize("s1")
                ready_sender.send("published")
                ready_sender.close()
                os._exit(17)

            process = context.Process(target=publish_then_crash)
            process.start()
            ready_sender.close()
            try:
                self.assertTrue(ready_receiver.poll(5), "child did not publish")
                self.assertEqual(ready_receiver.recv(), "published")
                process.join(timeout=5)
                self.assertFalse(process.is_alive(), "crashed child did not exit")
                self.assertEqual(process.exitcode, 17)
                self.assertTrue(log_path.is_file())

                fresh_controller = controller_module.ProlongController(
                    reader=FakeReader(),
                    projection_root=root,
                )
                fresh_controller.close()

                self.assertFalse(log_path.parent.exists())
            finally:
                ready_receiver.close()
                if process.is_alive():
                    process.kill()
                    process.join(timeout=5)

    def test_cleanup_holds_root_transaction_across_resolution_adoption_and_deletion(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = MultiSessionReader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            create_private_anchor(root)
            log_path.write_text(canonical_segment_line("s1"), encoding="utf-8")
            log_path.chmod(0o400)
            controller = module.ProlongController(reader=reader, projection_root=root)
            transaction_active = False
            events: list[str] = []

            class TrackingTransaction:
                def __enter__(self):
                    nonlocal transaction_active
                    transaction_active = True
                    events.append("transaction-enter")

                def __exit__(self, *_):
                    nonlocal transaction_active
                    events.append("transaction-exit")
                    transaction_active = False

            class TrackingStore:
                def adopt_for_cleanup(
                    self,
                    *,
                    allow_append_refresh=False,
                    _process_lock_held=False,
                ):
                    self_outer.assertTrue(transaction_active)
                    self_outer.assertTrue(allow_append_refresh)
                    self_outer.assertTrue(_process_lock_held)
                    events.append("adopt")

                def cleanup(self, *, _process_lock_held=False):
                    self_outer.assertTrue(transaction_active)
                    self_outer.assertTrue(_process_lock_held)
                    events.append("delete")

            self_outer = self
            store = TrackingStore()
            original_transaction = getattr(module, "projection_root_transaction")

            def tracking_transaction(projection_root: Path):
                self.assertEqual(projection_root, root)
                return TrackingTransaction()

            def resolve_root(session_id: str) -> str:
                self.assertTrue(transaction_active)
                self.assertEqual(session_id, "s1")
                events.append("resolve")
                return session_id

            def adopt_store(root_session_id: str):
                self.assertTrue(transaction_active)
                self.assertEqual(root_session_id, "s1")
                return store

            setattr(module, "projection_root_transaction", tracking_transaction)
            controller._resolve_cleanup_root = resolve_root
            controller._store_for = adopt_store
            try:
                controller.cleanup("s1")
            finally:
                setattr(module, "projection_root_transaction", original_transaction)

            self.assertEqual(
                events,
                [
                    "transaction-enter",
                    "resolve",
                    "adopt",
                    "delete",
                    "transaction-exit",
                ],
            )
            controller.close()

    def test_cleanup_refuses_a_dangling_projection_symlink(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            create_private_anchor(root)
            log_path.symlink_to(log_path.parent / "missing")
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG log"):
                controller.cleanup("s1")

            self.assertTrue(os.path.lexists(log_path))
            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

    def test_cold_cleanup_removes_private_crash_temporary_residue(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            session_directory = create_private_anchor(root)
            temporary_path = session_directory / ".trajectory-crash.tmp"
            temporary_path.write_text("partial", encoding="utf-8")
            temporary_path.chmod(0o600)
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            controller.cleanup("s1")

            self.assertFalse(session_directory.exists())
            controller.close()

    def test_cold_close_refuses_an_inherited_nonprivate_projection_root(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            plugin_data = base / "plugin-data"
            prolong = plugin_data / "prolong"
            root = prolong / "sessions"
            session_directory = root / "s1"
            plugin_data.mkdir(mode=0o700)
            prolong.mkdir(mode=0o700)
            root.mkdir(mode=0o755)
            session_directory.mkdir(mode=0o700)
            log_path = session_directory / "trajectory.jsonl"
            log_path.write_text(canonical_segment_line("s1"), encoding="utf-8")
            log_path.chmod(0o400)
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o755)
            self.assertTrue(log_path.is_file())

    def test_cold_close_refuses_an_unsafe_inherited_projection_log(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            session_directory = create_private_anchor(root)
            outside = Path(directory) / "outside"
            outside.write_text("must remain", encoding="utf-8")
            log_path = session_directory / "trajectory.jsonl"
            log_path.symlink_to(outside)
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

            self.assertTrue(log_path.is_symlink())
            self.assertEqual(outside.read_text(encoding="utf-8"), "must remain")

    def test_cold_close_refuses_an_unsafe_inherited_lease_file(self) -> None:
        load_plugin_module()
        controller_module = importlib.import_module(
            "test_hermes_prolong_plugin.controller"
        )
        projection_module = importlib.import_module(
            "test_hermes_prolong_plugin.projection"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            projection_module.ProjectionStore(log_path).sync(
                tuple(FakeReader().records)
            )
            lease_directory = root / ".leases"
            lease_directory.mkdir(mode=0o700)
            lease_path = lease_directory / "s1"
            lease_path.write_bytes(b"inherited")
            lease_path.chmod(0o644)
            controller = controller_module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                controller.close()

            self.assertTrue(log_path.is_file())
            self.assertEqual(lease_path.read_bytes(), b"inherited")
            self.assertEqual(stat.S_IMODE(lease_path.stat().st_mode), 0o644)

    def test_finalize_waits_for_an_admitted_projection_path(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        entered = threading.Event()
        release = threading.Event()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            original_synchronize = controller._synchronize_admitted

            def pausing_synchronize(session_id: str, *, force_rebuild: bool = False):
                result = original_synchronize(
                    session_id,
                    force_rebuild=force_rebuild,
                )
                entered.set()
                if not release.wait(timeout=2):
                    raise TimeoutError("projection path was not released")
                return result

            controller._synchronize_admitted = pausing_synchronize
            paths: list[Path] = []
            path_thread = threading.Thread(
                target=lambda: paths.append(controller.projection_path("s1"))
            )
            path_thread.start()
            self.assertTrue(entered.wait(timeout=2))

            finalize_thread = threading.Thread(
                target=controller.on_session_finalize,
                kwargs={"session_id": "s1"},
            )
            finalize_thread.start()
            time.sleep(0.05)
            self.assertTrue(finalize_thread.is_alive())

            release.set()
            path_thread.join(timeout=2)
            finalize_thread.join(timeout=2)
            self.assertFalse(path_thread.is_alive())
            self.assertFalse(finalize_thread.is_alive())
            self.assertEqual(paths, [root / "s1" / "trajectory.jsonl"])
            self.assertFalse((root / "s1").exists())
            controller.close()

    def test_close_waits_for_an_admitted_projection_path(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        entered = threading.Event()
        release = threading.Event()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            original_synchronize = controller._synchronize_admitted

            def pausing_synchronize(session_id: str, *, force_rebuild: bool = False):
                result = original_synchronize(
                    session_id,
                    force_rebuild=force_rebuild,
                )
                entered.set()
                if not release.wait(timeout=2):
                    raise TimeoutError("projection path was not released")
                return result

            controller._synchronize_admitted = pausing_synchronize
            path_thread = threading.Thread(
                target=controller.projection_path, args=("s1",)
            )
            path_thread.start()
            self.assertTrue(entered.wait(timeout=2))

            close_thread = threading.Thread(target=controller.close)
            close_thread.start()
            time.sleep(0.05)
            self.assertTrue(close_thread.is_alive())

            release.set()
            path_thread.join(timeout=2)
            close_thread.join(timeout=2)
            self.assertFalse(path_thread.is_alive())
            self.assertFalse(close_thread.is_alive())
            self.assertFalse((root / "s1").exists())

    def test_concurrent_close_waits_for_physical_cleanup_completion(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = FakeReader()
        cleanup_entered = threading.Event()
        release_cleanup = threading.Event()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            controller.synchronize("s1")
            log_path = root / "s1" / "trajectory.jsonl"
            store = controller._stores["s1"]
            real_cleanup = store.cleanup

            def blocking_cleanup(*args, **kwargs) -> None:
                cleanup_entered.set()
                if not release_cleanup.wait(timeout=5):
                    raise TimeoutError("test did not release close cleanup")
                real_cleanup(*args, **kwargs)

            store.cleanup = blocking_cleanup
            first_close = threading.Thread(target=controller.close)
            second_close = threading.Thread(target=controller.close)
            first_close.start()
            self.assertTrue(cleanup_entered.wait(timeout=2))
            second_close.start()
            time.sleep(0.05)

            try:
                self.assertTrue(first_close.is_alive())
                self.assertTrue(second_close.is_alive())
                self.assertTrue(log_path.exists())
                self.assertFalse(reader.closed)
            finally:
                release_cleanup.set()
                first_close.join(timeout=2)
                second_close.join(timeout=2)

            self.assertFalse(first_close.is_alive())
            self.assertFalse(second_close.is_alive())
            self.assertFalse(log_path.exists())
            self.assertTrue(reader.closed)

    def test_session_start_during_close_does_not_resurrect_controller_state(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = FakeReader()
        cleanup_entered = threading.Event()
        release_cleanup = threading.Event()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            controller.synchronize("s1")
            store = controller._stores["s1"]
            real_cleanup = store.cleanup

            def blocking_cleanup(*args, **kwargs) -> None:
                cleanup_entered.set()
                if not release_cleanup.wait(timeout=5):
                    raise TimeoutError("test did not release close cleanup")
                real_cleanup(*args, **kwargs)

            store.cleanup = blocking_cleanup
            close_thread = threading.Thread(target=controller.close)
            close_thread.start()
            self.assertTrue(cleanup_entered.wait(timeout=2))

            try:
                self.assertIsNone(controller.on_session_start(session_id="s2"))
                self.assertEqual(controller._session_roots, {})
                self.assertEqual(controller._last_errors, {})
            finally:
                release_cleanup.set()
                close_thread.join(timeout=2)

            self.assertFalse(close_thread.is_alive())
            self.assertTrue(reader.closed)

    def test_close_waits_for_in_flight_sync_and_prevents_republication(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = BlockingReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            log_path = root / "s1" / "trajectory.jsonl"
            sync_thread = threading.Thread(target=controller.synchronize, args=("s1",))
            sync_thread.start()
            self.assertTrue(reader.entered.wait(timeout=2))

            close_thread = threading.Thread(target=controller.close)
            close_thread.start()
            time.sleep(0.05)
            self.assertTrue(close_thread.is_alive())

            reader.release.set()
            sync_thread.join(timeout=2)
            close_thread.join(timeout=2)
            self.assertFalse(sync_thread.is_alive())
            self.assertFalse(close_thread.is_alive())
            self.assertFalse(log_path.exists())
            self.assertTrue(reader.closed)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                controller.synchronize("s1")

    def test_finalize_waits_for_in_flight_sync_and_retires_the_session(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        reader = BlockingLineageReader()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(reader=reader, projection_root=root)
            log_path = root / "s1" / "trajectory.jsonl"
            controller.synchronize("s1")
            reader.block_next_lineage = True

            sync_thread = threading.Thread(target=controller.synchronize, args=("s1",))
            sync_thread.start()
            self.assertTrue(reader.entered.wait(timeout=2))
            finalize_thread = threading.Thread(
                target=controller.on_session_finalize,
                kwargs={"session_id": "s1"},
            )
            finalize_thread.start()
            time.sleep(0.05)
            self.assertTrue(finalize_thread.is_alive())

            reader.release.set()
            sync_thread.join(timeout=2)
            finalize_thread.join(timeout=2)
            self.assertFalse(sync_thread.is_alive())
            self.assertFalse(finalize_thread.is_alive())
            self.assertFalse(log_path.parent.exists())
            with self.assertRaisesRegex(RuntimeError, "finalized"):
                controller.synchronize("s1")
            controller.close()

    def test_new_acquisition_waits_for_exclusive_cleanup_under_root_lock(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller_a = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            controller_b = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )
            log_path = controller_a.projection_path("s1")
            store = controller_a._stores["s1"]
            real_cleanup = store.cleanup
            cleanup_entered = threading.Event()
            release_cleanup = threading.Event()
            acquisition_attempted = threading.Event()
            acquisition_entered = threading.Event()
            errors: list[BaseException] = []
            original_transaction = module.projection_root_transaction

            @module.contextmanager
            def tracking_transaction(projection_root: Path):
                is_acquirer = threading.current_thread().name == "new-acquirer"
                if is_acquirer:
                    acquisition_attempted.set()
                with original_transaction(projection_root):
                    if is_acquirer:
                        acquisition_entered.set()
                    yield

            def blocking_cleanup(*args, **kwargs) -> None:
                cleanup_entered.set()
                if not release_cleanup.wait(timeout=5):
                    raise TimeoutError("test did not release exclusive cleanup")
                real_cleanup(*args, **kwargs)

            def acquire_projection() -> None:
                try:
                    controller_b.synchronize("s1")
                except BaseException as error:
                    errors.append(error)

            store.cleanup = blocking_cleanup
            setattr(module, "projection_root_transaction", tracking_transaction)
            close_thread = threading.Thread(target=controller_a.close)
            acquire_thread = threading.Thread(
                target=acquire_projection,
                name="new-acquirer",
            )
            try:
                close_thread.start()
                self.assertTrue(cleanup_entered.wait(timeout=2))
                acquire_thread.start()
                self.assertTrue(acquisition_attempted.wait(timeout=2))
                self.assertFalse(acquisition_entered.wait(timeout=0.1))
            finally:
                release_cleanup.set()
                close_thread.join(timeout=5)
                acquire_thread.join(timeout=5)
                setattr(module, "projection_root_transaction", original_transaction)

            self.assertFalse(close_thread.is_alive())
            self.assertFalse(acquire_thread.is_alive())
            self.assertEqual(errors, [])
            self.assertTrue(acquisition_entered.is_set())
            self.assertTrue(log_path.is_file())
            controller_b.close()
            self.assertFalse(log_path.parent.exists())

    def test_sync_failure_is_visible_to_the_model_but_does_not_break_hooks(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "controller.py"
        self.assertTrue(module_path.is_file(), f"controller is missing: {module_path}")
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")

        with tempfile.TemporaryDirectory() as directory:
            controller = module.ProlongController(
                reader=FailingReader(),
                hermes_home=Path(directory),
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                pre_llm_result = controller.pre_llm_call(session_id="s1")
            self.assertEqual(pre_llm_result["context_type"], "prolong_sync_warning")
            self.assertIn("may not be current", pre_llm_result["context"])

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                self.assertIsNone(
                    controller.pre_tool_call(
                        session_id="s1",
                        tool_name="read_file",
                        tool_args={},
                    )
                )


if __name__ == "__main__":
    unittest.main()
