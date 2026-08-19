from __future__ import annotations

import importlib
import json
import os
import stat
import tempfile
import unittest
import unittest.mock
from pathlib import Path

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
        "compression_count": None,
        "rewind_count": None,
    }


def canonical_message(
    message_id: int,
    *,
    session_id: str = "s1",
    content: object = "message",
) -> dict:
    return {
        "id": message_id,
        "session_id": session_id,
        "role": "user",
        "content": content,
        "tool_call_id": None,
        "tool_calls": None,
        "tool_name": None,
        "effect_disposition": None,
        "timestamp": 1.0,
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


class ProjectionStoreTests(unittest.TestCase):
    def test_sync_creates_a_private_fresh_runtime_home(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            runtime_home = Path(directory) / "new-hermes-home"
            log_path = (
                runtime_home
                / "plugin-data"
                / "prolong"
                / "sessions"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)

            store.sync(({"record_type": "message", "message": {"id": 1}},))

            self.assertTrue(log_path.is_file())
            self.assertEqual(stat.S_IMODE(runtime_home.stat().st_mode), 0o700)

    def test_relative_projection_root_does_not_chmod_the_working_directory(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            working_directory = Path(directory)
            working_directory.chmod(0o755)
            previous_working_directory = Path.cwd()
            try:
                os.chdir(working_directory)
                store = module.ProjectionStore(
                    Path("plugin-data")
                    / "prolong"
                    / "sessions"
                    / "session-1"
                    / "trajectory.jsonl"
                )

                store.sync(({"record_type": "message", "message": {"id": 1}},))

                self.assertEqual(
                    stat.S_IMODE(working_directory.stat().st_mode),
                    0o755,
                )
            finally:
                os.chdir(previous_working_directory)

    def test_relative_canonical_root_rejects_a_nonprivate_existing_home(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        for operation in ("root-transaction", "store"):
            with (
                self.subTest(operation=operation),
                tempfile.TemporaryDirectory() as directory,
            ):
                working_directory = Path(directory)
                previous_working_directory = Path.cwd()
                try:
                    os.chdir(working_directory)
                    home = Path("hermes-home")
                    home.mkdir(mode=0o755)
                    home.chmod(0o755)
                    root = home / "plugin-data" / "prolong" / "sessions"

                    with self.assertRaisesRegex(
                        RuntimeError, "unsafe PRO-LONG directory"
                    ):
                        if operation == "root-transaction":
                            with module.projection_root_transaction(root):
                                pass
                        else:
                            store = module.ProjectionStore(
                                root / "s1" / "trajectory.jsonl"
                            )
                            store.sync(
                                ({"record_type": "message", "message": {"id": 1}},)
                            )

                    self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o755)
                finally:
                    os.chdir(previous_working_directory)

    def test_shallow_relative_projection_root_does_not_chmod_the_working_directory(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            working_directory = Path(directory)
            working_directory.chmod(0o755)
            previous_working_directory = Path.cwd()
            try:
                os.chdir(working_directory)
                store = module.ProjectionStore(
                    Path("sessions") / "session-1" / "trajectory.jsonl"
                )

                store.sync(({"record_type": "message", "message": {"id": 1}},))

                self.assertEqual(
                    stat.S_IMODE(working_directory.stat().st_mode),
                    0o755,
                )
            finally:
                os.chdir(previous_working_directory)

    def test_shallow_absolute_projection_root_ignores_unrelated_tmp_ancestor(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        records = (
            {
                "record_type": "message",
                "lineage_index": 0,
                "session_id": "s1",
                "message": {"id": 1},
            },
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "sessions"
            with module.projection_root_transaction(root):
                pass
            store = module.ProjectionStore(root / "s1" / "trajectory.jsonl")
            store.sync(records)

            self.assertTrue(store.log_path.is_file())
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)

    def test_projection_paths_do_not_chmod_unrelated_owner_ancestor(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        records = (
            {
                "record_type": "message",
                "lineage_index": 0,
                "session_id": "s1",
                "message": {"id": 1},
            },
        )

        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory) / "unrelated"
            outer.mkdir(mode=0o755)
            root = outer / "sessions"
            with module.projection_root_transaction(root):
                pass
            module.ProjectionStore(root / "s1" / "trajectory.jsonl").sync(records)

            self.assertEqual(stat.S_IMODE(outer.stat().st_mode), 0o755)

    def test_existing_nonprivate_canonical_home_is_rejected_unchanged(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        records = (
            {
                "record_type": "message",
                "lineage_index": 0,
                "session_id": "s1",
                "message": {"id": 1},
            },
        )

        for operation in ("root-transaction", "store-sync"):
            with (
                self.subTest(operation=operation),
                tempfile.TemporaryDirectory() as directory,
            ):
                runtime_home = Path(directory) / "hermes-home"
                runtime_home.mkdir(mode=0o755)
                root = runtime_home / "plugin-data" / "prolong" / "sessions"

                with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG directory"):
                    if operation == "root-transaction":
                        with module.projection_root_transaction(root):
                            pass
                    else:
                        module.ProjectionStore(root / "s1" / "trajectory.jsonl").sync(
                            records
                        )

                self.assertEqual(stat.S_IMODE(runtime_home.stat().st_mode), 0o755)

    def test_sync_refuses_a_symlinked_runtime_home(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir(mode=0o700)
            runtime_home = root / "hermes-home"
            runtime_home.symlink_to(outside, target_is_directory=True)
            log_path = (
                runtime_home
                / "plugin-data"
                / "prolong"
                / "sessions"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)

            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG directory"):
                store.sync(({"record_type": "message", "message": {"id": 1}},))

            self.assertFalse((outside / "plugin-data").exists())

    def test_rebuilds_then_appends_only_a_new_suffix_and_noops_when_unchanged(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            first = [
                {
                    "record_type": "session_segment",
                    "lineage_index": 0,
                    "session": {"id": "s"},
                },
                {
                    "record_type": "message",
                    "lineage_index": 0,
                    "session_id": "s",
                    "message": {"id": 1, "content": "first line\nΚαλημέρα 👋"},
                },
            ]
            second = [
                *first,
                {
                    "record_type": "message",
                    "lineage_index": 0,
                    "session_id": "s",
                    "message": {"id": 2, "content": "suffix"},
                },
            ]

            rebuilt = store.sync(first)
            rebuilt_stat = log_path.stat()
            rebuilt_content = log_path.read_text(encoding="utf-8")

            self.assertEqual(rebuilt.mode, "rebuild")
            self.assertEqual(rebuilt.record_count, 2)
            self.assertEqual(os.stat(log_path.parent).st_mode & 0o777, 0o700)
            self.assertEqual(rebuilt_stat.st_mode & 0o777, 0o400)
            self.assertTrue(rebuilt_content.endswith("\n"))
            self.assertEqual(
                [json.loads(line) for line in rebuilt_content.splitlines()],
                first,
            )

            append_modes: list[int] = []
            real_fchmod = module.os.fchmod

            def tracked_fchmod(descriptor: int, mode: int) -> None:
                append_modes.append(mode)
                real_fchmod(descriptor, mode)

            with unittest.mock.patch.object(
                module.os, "fchmod", side_effect=tracked_fchmod
            ):
                appended = store.sync(second)
            appended_stat = log_path.stat()
            appended_content = log_path.read_text(encoding="utf-8")

            self.assertEqual(appended.mode, "append")
            self.assertEqual(append_modes, [0o600, 0o400])
            self.assertEqual(appended_stat.st_ino, rebuilt_stat.st_ino)
            self.assertTrue(appended_content.startswith(rebuilt_content))
            self.assertEqual(
                [json.loads(line) for line in appended_content.splitlines()],
                second,
            )
            self.assertEqual(appended_stat.st_mode & 0o777, 0o400)

            unchanged = store.sync(second)
            unchanged_stat = log_path.stat()
            self.assertEqual(unchanged.mode, "noop")
            self.assertEqual(unchanged_stat.st_mtime_ns, appended_stat.st_mtime_ns)
            self.assertEqual(unchanged_stat.st_ctime_ns, appended_stat.st_ctime_ns)

    def test_forced_refresh_and_divergence_atomically_rebuild_exact_records(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            original = [
                {"record_type": "message", "message": {"id": 1, "content": "old"}}
            ]
            changed = [
                {"record_type": "message", "message": {"id": 1, "content": "new"}}
            ]

            store.sync(original)
            original_inode = log_path.stat().st_ino
            forced = store.sync(original, force_rebuild=True)
            forced_inode = log_path.stat().st_ino
            divergent = store.sync(changed)

            self.assertEqual(forced.mode, "rebuild")
            self.assertNotEqual(forced_inode, original_inode)
            self.assertEqual(divergent.mode, "rebuild")
            self.assertEqual(
                [
                    json.loads(line)
                    for line in log_path.read_text(encoding="utf-8").splitlines()
                ],
                changed,
            )

    def test_rebuild_fsyncs_the_containing_directory_after_atomic_replace(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            records = ({"record_type": "message", "message": {"id": 1}},)
            events: list[str] = []
            real_fsync = module.os.fsync
            real_replace = module.os.replace

            def tracked_fsync(descriptor: int) -> None:
                if stat.S_ISDIR(module.os.fstat(descriptor).st_mode):
                    events.append("directory-fsync")
                real_fsync(descriptor)

            def tracked_replace(source: Path, destination: Path) -> None:
                events.append("replace")
                real_replace(source, destination)

            with (
                unittest.mock.patch.object(
                    module.os, "fsync", side_effect=tracked_fsync
                ),
                unittest.mock.patch.object(
                    module.os, "replace", side_effect=tracked_replace
                ),
            ):
                store.sync(records)

            self.assertEqual(events, ["replace", "directory-fsync"])

    def test_refuses_a_symlinked_projection_root(self) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with (
            tempfile.TemporaryDirectory() as directory,
            tempfile.TemporaryDirectory() as outside,
        ):
            runtime = Path(directory) / "runtime"
            runtime.mkdir(mode=0o700)
            (runtime / "prolong").symlink_to(Path(outside), target_is_directory=True)
            log_path = runtime / "prolong" / "session-1" / "trajectory.jsonl"
            store = module.ProjectionStore(log_path)

            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG directory"):
                store.sync([{"record_type": "message", "message": {"id": 1}}])
            self.assertFalse((Path(outside) / "session-1").exists())

    def test_cleanup_removes_only_the_derived_session_directory_and_can_regenerate(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "runtime" / "prolong"
            log_path = root / "session-1" / "trajectory.jsonl"
            store = module.ProjectionStore(log_path)
            records = [{"record_type": "message", "message": {"id": 1}}]

            store.sync(records)
            store.cleanup()

            self.assertFalse(log_path.parent.exists())
            self.assertTrue(root.is_dir())
            store.cleanup()
            regenerated = store.sync(records)
            self.assertEqual(regenerated.mode, "rebuild")
            self.assertTrue(log_path.is_file())

    def test_cleanup_can_run_under_an_existing_projection_root_transaction(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "runtime" / "prolong"
            log_path = root / "session-1" / "trajectory.jsonl"
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))

            with module.projection_root_transaction(root):
                with unittest.mock.patch.object(
                    store,
                    "_acquire_process_lock",
                    side_effect=AssertionError(
                        "cleanup reacquired the root process lock"
                    ),
                ):
                    store.cleanup(_process_lock_held=True)

            self.assertFalse(log_path.parent.exists())

    def test_read_only_cleanup_adoption_rejects_malformed_projection_jsonl(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        def jsonl(*records: dict) -> bytes:
            return (
                "".join(
                    json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
                    for record in records
                )
            ).encode()

        canonical_segment = {
            "lineage_index": 0,
            "record_type": "session_segment",
            "session": canonical_session("s1"),
        }
        missing_fixed_message_field = canonical_message(1)
        missing_fixed_message_field.pop("effect_disposition")
        malformed_payloads = (
            b"",
            b"not-jsonl\n",
            b'{"record_type":"message"}\n',
            b'{"lineage_index":0,"record_type":"session_segment"}\n',
            b'{ "lineage_index":0,"record_type":"session_segment",'
            b'"session":{"id":"s1"}}\n',
            b'{"lineage_index":0,"record_type":"session_segment",'
            b'"session":{"compression_count":NaN,"id":"s1"}}\n',
            b'{"lineage_index":0,"message":{"id":1},'
            b'"record_type":"message","session_id":"s1"}\n',
            b'{"lineage_index":0,"record_type":"session_segment",'
            b'"session":{"id":"s1"}}\n'
            b'{"lineage_index":2,"record_type":"session_segment",'
            b'"session":{"id":"s2"}}\n',
            b'{"lineage_index":0,"record_type":"session_segment",'
            b'"session":{"id":"s1"}}\n'
            b'{"lineage_index":0,"message":{"id":1,"role":"user"},'
            b'"record_type":"message","session_id":"s1"}\n'
            b'{"chunk_count":2,"chunk_index":0,"content":"first",'
            b'"content_encoding":"text","lineage_index":0,"message_id":1,'
            b'"record_type":"message_content_chunk","role":"user",'
            b'"session_id":"s1","tool_call_id":null}\n',
            b'{"chunk_count":1,"chunk_index":2,"content":"x",'
            b'"lineage_index":0,"record_type":"message_content_chunk",'
            b'"session_id":"s1"}\n',
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": {"id": "s1"},
                }
            ),
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": canonical_session("../foreign"),
                }
            ),
            jsonl(
                canonical_segment,
                {
                    "lineage_index": 0,
                    "message": missing_fixed_message_field,
                    "record_type": "message",
                    "session_id": "s1",
                },
            ),
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": {
                        **canonical_session("s1"),
                        "compression_count": True,
                    },
                }
            ),
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": {
                        **canonical_session("s1"),
                        "parent_session_id": "../escape",
                    },
                }
            ),
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": {
                        **canonical_session("s1"),
                        "parent_session_id": 7,
                    },
                }
            ),
            jsonl(
                canonical_segment,
                {
                    "lineage_index": 1,
                    "record_type": "session_segment",
                    "session": canonical_session("s1", "s1"),
                },
            ),
            jsonl(
                {
                    "lineage_index": 0,
                    "record_type": "session_segment",
                    "session": canonical_session("a", "c"),
                },
                {
                    "lineage_index": 1,
                    "record_type": "session_segment",
                    "session": canonical_session("b", "a"),
                },
                {
                    "lineage_index": 2,
                    "record_type": "session_segment",
                    "session": canonical_session("c", "b"),
                },
            ),
            jsonl(
                canonical_segment,
                {
                    "lineage_index": 0,
                    "message": canonical_message(1, session_id="other"),
                    "record_type": "message",
                    "session_id": "s1",
                },
            ),
            jsonl(
                canonical_segment,
                {
                    "lineage_index": 0,
                    "message": {"id": 1},
                    "record_type": "message",
                    "session_id": "s1",
                },
            ),
            jsonl(
                canonical_segment,
                {
                    "extra": "unsupported",
                    "lineage_index": 0,
                    "message": {"id": 1},
                    "record_type": "message",
                    "session_id": "s1",
                },
            ),
            (
                json.dumps(
                    {
                        "lineage_index": 0,
                        "record_type": "session_segment",
                        "session": canonical_session("s1"),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
                + json.dumps(
                    {
                        "lineage_index": 0,
                        "message": canonical_message(1, content="A" * 800),
                        "record_type": "message",
                        "session_id": "s1",
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
            ).encode(),
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
                store = module.ProjectionStore(log_path)

                with self.assertRaisesRegex(RuntimeError, "valid PRO-LONG projection"):
                    with module.projection_root_transaction(root):
                        store.adopt_for_cleanup(_process_lock_held=True)

                self.assertEqual(log_path.read_bytes(), payload)

    def test_read_only_cleanup_adoption_accepts_available_lineage_after_ancestor_deletion(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        reader_module = importlib.import_module(
            "test_hermes_prolong_plugin.session_reader"
        )
        message = canonical_message(1, content="A" * 800)
        records = (
            {
                "lineage_index": 0,
                "record_type": "session_segment",
                "session": canonical_session("s1", "deleted-root"),
            },
            {
                "lineage_index": 0,
                "message": message,
                "record_type": "message",
                "session_id": "s1",
            },
            *reader_module._message_content_chunks(
                message,
                session_id="s1",
                lineage_index=0,
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            log_path = root / "s1" / "trajectory.jsonl"
            store = module.ProjectionStore(log_path)
            store.sync(records)
            adopted = module.ProjectionStore(log_path)

            with module.projection_root_transaction(root):
                adopted.adopt_for_cleanup(_process_lock_held=True)
                adopted.cleanup(_process_lock_held=True)

            self.assertFalse(log_path.exists())

    def test_cleanup_removes_only_leftover_private_trajectory_temporary_files(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            writable_temporary = log_path.parent / ".trajectory-writable.tmp"
            readonly_temporary = log_path.parent / ".trajectory-readonly.tmp"
            writable_temporary.write_bytes(b"partial")
            writable_temporary.chmod(0o600)
            readonly_temporary.write_bytes(b"complete")
            readonly_temporary.chmod(0o400)

            store.cleanup()

            self.assertFalse(log_path.parent.exists())

    def test_cleanup_removes_private_cleanup_quarantine_residue(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            quarantine = log_path.parent / ".prolong-cleanup-crash.tmp"
            quarantine.write_bytes(b"captured derived projection")
            quarantine.chmod(0o600)

            store.cleanup()

            self.assertFalse(log_path.parent.exists())

    def test_cleanup_removes_an_unchanged_private_log_left_writable(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            log_path.chmod(0o600)

            store.cleanup()

            self.assertFalse(log_path.parent.exists())

    def test_cleanup_revalidates_log_identity_immediately_before_unlink(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            saved_original = log_path.parent / "saved-original"
            replacement = Path(directory) / "replacement"
            replacement.write_text('{"record_type":"replacement"}\n', encoding="utf-8")
            replacement.chmod(0o400)
            original_read_signature = module._read_signature
            swapped = False

            def swap_after_validation(path, *args, **kwargs):
                nonlocal swapped
                signature = original_read_signature(path, *args, **kwargs)
                if Path(path) == log_path and not swapped:
                    swapped = True
                    os.replace(log_path, saved_original)
                    os.replace(replacement, log_path)
                return signature

            with unittest.mock.patch.object(
                module, "_read_signature", side_effect=swap_after_validation
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed PRO-LONG log|unexpected PRO-LONG cleanup",
                ):
                    store.cleanup()

            self.assertEqual(
                log_path.read_text(encoding="utf-8"),
                '{"record_type":"replacement"}\n',
            )
            self.assertTrue(saved_original.is_file())

    def test_cleanup_captures_log_before_deleting_after_final_validation(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            saved_original = log_path.parent / "saved-original"
            replacement = Path(directory) / "replacement"
            replacement.write_text('{"record_type":"replacement"}\n', encoding="utf-8")
            replacement.chmod(0o400)
            original_read_signature = module._read_signature
            validation_count = 0

            def swap_after_final_validation(path, *args, **kwargs):
                nonlocal validation_count
                signature = original_read_signature(path, *args, **kwargs)
                if Path(path) == log_path:
                    validation_count += 1
                    if validation_count == 2:
                        os.replace(log_path, saved_original)
                        os.replace(replacement, log_path)
                return signature

            with unittest.mock.patch.object(
                module, "_read_signature", side_effect=swap_after_final_validation
            ):
                with self.assertRaisesRegex(RuntimeError, "changed PRO-LONG log"):
                    store.cleanup()

            self.assertEqual(
                log_path.read_text(encoding="utf-8"),
                '{"record_type":"replacement"}\n',
            )
            self.assertTrue(saved_original.is_file())

    def test_cleanup_revalidates_temporary_artifact_before_unlink(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            temporary = log_path.parent / ".trajectory-race.tmp"
            temporary.write_bytes(b"private temporary")
            temporary.chmod(0o600)
            outside = Path(directory) / "outside"
            outside.write_bytes(b"outside")
            original_validate = module._validate_regular_file
            swapped = False

            def swap_after_validation(metadata, *, expected_mode, label):
                nonlocal swapped
                original_validate(
                    metadata,
                    expected_mode=expected_mode,
                    label=label,
                )
                if Path(label) == temporary and not swapped:
                    swapped = True
                    temporary.unlink()
                    temporary.symlink_to(outside)

            with unittest.mock.patch.object(
                module,
                "_validate_regular_file",
                side_effect=swap_after_validation,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "unsafe PRO-LONG cleanup artifact"
                ):
                    store.cleanup()

            self.assertTrue(temporary.is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")

    def test_cleanup_captures_temporary_before_deleting_after_final_validation(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            temporary = log_path.parent / ".trajectory-final-race.tmp"
            temporary.write_bytes(b"private temporary")
            temporary.chmod(0o600)
            outside = Path(directory) / "outside"
            outside.write_bytes(b"outside")
            original_validate = module._validate_regular_file
            validation_count = 0

            def swap_after_final_validation(metadata, *, expected_mode, label):
                nonlocal validation_count
                original_validate(
                    metadata,
                    expected_mode=expected_mode,
                    label=label,
                )
                if Path(label) == temporary:
                    validation_count += 1
                    if validation_count == 2:
                        temporary.unlink()
                        temporary.symlink_to(outside)

            with unittest.mock.patch.object(
                module,
                "_validate_regular_file",
                side_effect=swap_after_final_validation,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "unsafe PRO-LONG cleanup artifact"
                ):
                    store.cleanup()

            self.assertTrue(temporary.is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")

    def test_cleanup_refuses_arbitrary_non_trajectory_artifacts(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            unrelated = log_path.parent / "unrelated-private-file"
            unrelated.write_bytes(b"must not be removed")
            unrelated.chmod(0o600)

            with self.assertRaisesRegex(RuntimeError, "unexpected PRO-LONG cleanup"):
                store.cleanup()

            self.assertTrue(unrelated.exists())
            self.assertTrue(log_path.exists())
            self.assertTrue(log_path.parent.exists())

    def test_cleanup_refuses_unsafe_artifacts_with_temporary_names(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            outside = Path(directory) / "outside"
            outside.write_bytes(b"must not be removed")
            unsafe_temporary = log_path.parent / ".trajectory-symlink.tmp"
            unsafe_temporary.symlink_to(outside)

            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG cleanup"):
                store.cleanup()

            self.assertTrue(unsafe_temporary.is_symlink())
            self.assertTrue(log_path.exists())
            self.assertEqual(outside.read_bytes(), b"must not be removed")

    def test_cleanup_restores_the_log_if_an_artifact_appears_after_capture(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(({"record_type": "message", "message": {"id": 1}},))
            expected_payload = log_path.read_bytes()
            unexpected = log_path.parent / "appeared-during-capture"
            original_check = store._require_only_quarantined_log

            def inject_then_check(quarantine_path):
                unexpected.write_bytes(b"preserve")
                unexpected.chmod(0o600)
                original_check(quarantine_path)

            with unittest.mock.patch.object(
                store,
                "_require_only_quarantined_log",
                side_effect=inject_then_check,
            ):
                with self.assertRaisesRegex(RuntimeError, "changed PRO-LONG log"):
                    store.cleanup()

            self.assertEqual(log_path.read_bytes(), expected_payload)
            self.assertEqual(unexpected.read_bytes(), b"preserve")

    def test_external_modification_forces_rebuild_and_changed_cleanup_fails_closed(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            records = [
                {"record_type": "message", "message": {"id": 1, "content": "canonical"}}
            ]

            store.sync(records)
            log_path.chmod(0o600)
            log_path.write_text('{"record_type":"tampered"}\n', encoding="utf-8")
            log_path.chmod(0o400)
            repaired = store.sync(records)
            self.assertEqual(repaired.mode, "rebuild")
            self.assertEqual(
                [
                    json.loads(line)
                    for line in log_path.read_text(encoding="utf-8").splitlines()
                ],
                records,
            )

            log_path.chmod(0o600)
            log_path.write_text('{"record_type":"changed-again"}\n', encoding="utf-8")
            log_path.chmod(0o400)
            with self.assertRaisesRegex(RuntimeError, "changed PRO-LONG log"):
                store.cleanup()
            self.assertTrue(log_path.exists())

    def test_sync_atomically_recovers_a_private_log_left_in_writable_mode(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            records = (
                {
                    "record_type": "message",
                    "message": {"id": 1, "content": "canonical"},
                },
            )
            store.sync(records)
            previous_inode = log_path.stat().st_ino
            log_path.chmod(0o600)
            log_path.write_text('{"record_type":"interrupted"}\n', encoding="utf-8")

            recovered = store.sync(records)

            self.assertEqual(recovered.mode, "rebuild")
            self.assertNotEqual(log_path.stat().st_ino, previous_inode)
            self.assertEqual(stat.S_IMODE(log_path.stat().st_mode), 0o400)
            self.assertEqual(
                [
                    json.loads(line)
                    for line in log_path.read_text(encoding="utf-8").splitlines()
                ],
                list(records),
            )

    def test_reuses_an_immutable_snapshot_without_reserializing_all_records(
        self,
    ) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            records = tuple(
                {"record_type": "message", "message": {"id": index}}
                for index in range(100)
            )
            store.sync(records)
            original_serialize = getattr(module, "_serialize")

            def fail_if_called(record):
                raise AssertionError(f"unchanged snapshot was reserialized: {record}")

            setattr(module, "_serialize", fail_if_called)
            try:
                result = store.sync(records)
            finally:
                setattr(module, "_serialize", original_serialize)

            lock_path = log_path.parent.parent / ".prolong.lock"
            self.assertTrue(lock_path.is_file())
            self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)
            self.assertEqual(result.mode, "noop")
            self.assertEqual(result.record_count, 100)

    def test_refuses_preexisting_unsafe_or_hardlinked_log_objects(self) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        records = ({"record_type": "message", "message": {"id": 1}},)

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            log_path.parent.mkdir(mode=0o700, parents=True)
            log_path.parent.parent.chmod(0o700)
            log_path.write_text('{"record_type":"foreign"}\n', encoding="utf-8")
            log_path.chmod(0o644)
            store = module.ProjectionStore(log_path)
            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG log"):
                store.sync(records)

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            store.sync(records)
            hardlink = log_path.with_name("second-link.jsonl")
            os.link(log_path, hardlink)
            with self.assertRaisesRegex(RuntimeError, "unsafe PRO-LONG log"):
                store.sync(records)
            self.assertTrue(hardlink.exists())

    def test_retries_partial_writes_until_every_jsonl_byte_is_persisted(self) -> None:
        module_path = PLUGIN_DIR / "projection.py"
        self.assertTrue(
            module_path.is_file(), f"projection store is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        records = tuple(
            {"record_type": "message", "message": {"id": index, "content": "payload"}}
            for index in range(10)
        )

        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory)
                / "runtime"
                / "prolong"
                / "session-1"
                / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            original_write = module.os.write
            original_mkstemp = module.tempfile.mkstemp
            projection_descriptors: set[int] = set()
            partial_write_calls = 0

            def tracked_mkstemp(*args, **kwargs):
                descriptor, temporary_name = original_mkstemp(*args, **kwargs)
                projection_descriptors.clear()
                projection_descriptors.add(descriptor)
                return descriptor, temporary_name

            def partial_write(descriptor, payload):
                nonlocal partial_write_calls
                if descriptor in projection_descriptors:
                    partial_write_calls += 1
                    payload = payload[:7]
                return original_write(descriptor, payload)

            with (
                unittest.mock.patch.object(
                    module.tempfile, "mkstemp", side_effect=tracked_mkstemp
                ),
                unittest.mock.patch.object(
                    module.os, "write", side_effect=partial_write
                ),
            ):
                store.sync(records)

            actual = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertGreater(partial_write_calls, 1)
            self.assertEqual(actual, list(records))

    def test_append_restores_read_only_mode_when_fchmod_is_interrupted(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.projection")
        with tempfile.TemporaryDirectory() as directory:
            log_path = (
                Path(directory) / "runtime" / "prolong" / "s1" / "trajectory.jsonl"
            )
            store = module.ProjectionStore(log_path)
            first = ({"record_type": "message", "message": {"id": 1}},)
            second = (*first, {"record_type": "message", "message": {"id": 2}})
            store.sync(first)
            real_fchmod = module.os.fchmod
            interrupted = False

            def interrupt_after_chmod(descriptor: int, mode: int) -> None:
                nonlocal interrupted
                real_fchmod(descriptor, mode)
                if mode == 0o600 and not interrupted:
                    interrupted = True
                    raise KeyboardInterrupt

            with unittest.mock.patch.object(
                module.os, "fchmod", side_effect=interrupt_after_chmod
            ):
                with self.assertRaises(KeyboardInterrupt):
                    store.sync(second)

            self.assertEqual(stat.S_IMODE(log_path.stat().st_mode), 0o400)
            self.assertIn(store.sync(second).mode, {"append", "rebuild"})


if __name__ == "__main__":
    unittest.main()
