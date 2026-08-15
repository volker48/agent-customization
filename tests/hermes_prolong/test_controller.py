from __future__ import annotations

import importlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from tests.hermes_prolong.test_plugin_registration import PLUGIN_DIR, load_plugin_module


class FakeReader:
    def __init__(self) -> None:
        self.closed = False
        self.previous_values: list[object | None] = []
        self.returned: list[object] = []
        self.records = [
            {
                "record_type": "session_segment",
                "lineage_index": 0,
                "session": {"id": "s1"},
            },
            {
                "record_type": "message",
                "lineage_index": 0,
                "session_id": "s1",
                "message": {"id": 1, "content": "nonce"},
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
                "session": {"id": segment_id},
            }
            for index, segment_id in enumerate(lineage)
        ]
        records.append(
            {
                "record_type": "message",
                "lineage_index": len(lineage) - 1,
                "session_id": session_id,
                "message": {"id": len(lineage), "content": session_id},
            }
        )
        return SimpleNamespace(records=tuple(records), lineage=lineage)

    def session_exists(self, session_id: str) -> bool:
        return session_id in self.existing

    def close(self) -> None:
        self.closed = True


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
                    "message": {"id": 2, "content": "current turn"},
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

            reader.existing.clear()
            self.assertEqual(controller.sweep_orphans(), 1)

            self.assertFalse(root_log.parent.exists())
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
