from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_SOURCE = REPO_ROOT / "hermes-plugins" / "prolong"
HERMES_SOURCE = os.environ.get("HERMES_SOURCE")
_MISSING = object()
_HERMES_STATE_DEFAULTS = {
    "_state_db": None,
    "_state_db_path": None,
    "_state_db_failed": False,
}


def projection_path_from_prompt(manager, session_id: str) -> Path:
    rendered = manager.render_system_prompt_sections({"session_id": session_id})
    if len(rendered) != 1:
        raise AssertionError(
            f"expected one PRO-LONG prompt section, got {len(rendered)}"
        )
    marker = "private JSONL file '"
    _, found, remainder = rendered[0].content.partition(marker)
    if not found:
        raise AssertionError("PRO-LONG prompt section did not contain its JSONL path")
    path_text, separator, _ = remainder.partition("'")
    if not separator:
        raise AssertionError("PRO-LONG prompt JSONL path was not terminated")
    return Path(path_text)


@unittest.skipUnless(HERMES_SOURCE, "set HERMES_SOURCE to run installed-runtime tests")
class InstalledHermesRuntimeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_sys_path = list(sys.path)
        self._original_hermes_home = os.environ.get("HERMES_HOME", _MISSING)
        sys.path.insert(0, str(HERMES_SOURCE))
        try:
            self.plugins_module = importlib.import_module("hermes_cli.plugins")
            self.state_module = importlib.import_module("hermes_state")
        except Exception:
            sys.path[:] = self._original_sys_path
            raise
        self._original_state_globals = {
            name: getattr(self.state_module, name, _MISSING)
            for name in _HERMES_STATE_DEFAULTS
        }
        for name, value in _HERMES_STATE_DEFAULTS.items():
            setattr(self.state_module, name, value)
        self.addCleanup(self._restore_runtime_globals)

    def _use_runtime_home(self, home: Path) -> None:
        os.environ["HERMES_HOME"] = str(home)

    def _restore_runtime_globals(self) -> None:
        for name, value in self._original_state_globals.items():
            if value is _MISSING:
                delattr(self.state_module, name)
            else:
                setattr(self.state_module, name, value)
        if self._original_hermes_home is _MISSING:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = str(self._original_hermes_home)
        sys.path[:] = self._original_sys_path

    def test_plugin_manager_loads_hooks_and_projects_real_session_lineage(self) -> None:
        plugin_manager = self.plugins_module.PluginManager
        session_database = self.state_module.SessionDB

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._use_runtime_home(home)
            plugins_dir = home / "plugins"
            plugins_dir.mkdir(mode=0o700)
            (plugins_dir / "prolong").symlink_to(
                PLUGIN_SOURCE, target_is_directory=True
            )
            (home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - prolong\n",
                encoding="utf-8",
            )
            database = session_database(db_path=home / "state.db")
            self.addCleanup(database.close)
            root_id = "runtime-root"
            tip_id = "runtime-tip"
            database.create_session(root_id, "cli")
            database.append_message(root_id, "user", "runtime contract nonce")
            database.end_session(root_id, "compression")
            database.create_session(
                tip_id,
                "cli",
                parent_session_id=root_id,
            )
            database.append_message(tip_id, "assistant", "continuation")

            manager = plugin_manager(scope_key=str(home))
            self.addCleanup(manager.unload)
            manager.discover_and_load()
            self.assertIn("prolong", manager._plugins)
            self.assertEqual(len(manager.iter_hook_callbacks("pre_llm_call")), 1)
            log_path = projection_path_from_prompt(manager, tip_id)
            self.assertTrue(log_path.is_relative_to(home / "plugin-data"))
            self.assertEqual(log_path.parent.name, root_id)
            self.assertEqual(log_path.name, "trajectory.jsonl")

            results = manager.invoke_hook(
                "pre_llm_call",
                session_id=tip_id,
                user_message="query",
                conversation_history=[],
            )
            self.assertEqual(results, [])
            records = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            messages = [
                record["message"]["content"]
                for record in records
                if record["record_type"] == "message"
            ]
            self.assertEqual(messages, ["runtime contract nonce", "continuation"])

            self.assertTrue(manager.unload())
            self.assertFalse(log_path.parent.exists())
            database.close()

    def test_reconciliation_rebuilds_after_real_in_place_compaction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._use_runtime_home(home)
            plugins_dir = home / "plugins"
            plugins_dir.mkdir(mode=0o700)
            (plugins_dir / "prolong").symlink_to(
                PLUGIN_SOURCE, target_is_directory=True
            )
            (home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - prolong\n",
                encoding="utf-8",
            )
            database = self.state_module.SessionDB(db_path=home / "state.db")
            self.addCleanup(database.close)
            session_id = "runtime-in-place"
            database.create_session(session_id, "cli")
            database.append_message(session_id, "user", "full fidelity nonce")
            database.append_message(session_id, "assistant", "pre-compression answer")

            manager = self.plugins_module.PluginManager(scope_key=str(home))
            self.addCleanup(manager.unload)
            manager.discover_and_load()
            log_path = projection_path_from_prompt(manager, session_id)
            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                user_message="before compression",
                conversation_history=[],
            )
            database.archive_and_compact(
                session_id,
                [
                    {
                        "role": "user",
                        "content": "[CONTEXT COMPACTION — REFERENCE ONLY] summary",
                    },
                    {"role": "assistant", "content": "compacted handoff"},
                ],
            )

            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                user_message="after compression",
                conversation_history=[],
            )
            projected = [
                record["message"]
                for record in (
                    json.loads(line)
                    for line in log_path.read_text(encoding="utf-8").splitlines()
                )
                if record["record_type"] == "message"
            ]
            canonical = [
                message
                for message in database.get_messages(session_id, include_inactive=True)
                if message.get("active") or message.get("compacted")
            ]

            self.assertEqual(projected, canonical)
            self.assertTrue(any(message.get("compacted") for message in projected))
            self.assertTrue(any(message.get("active") for message in projected))
            self.assertTrue(manager.unload())
            database.close()

    def test_reconciliation_detects_a_real_non_tail_row_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._use_runtime_home(home)
            plugin_dir = home / "plugins" / "prolong"
            plugin_dir.parent.mkdir(parents=True)
            plugin_dir.symlink_to(PLUGIN_SOURCE, target_is_directory=True)
            (home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - prolong\n",
                encoding="utf-8",
            )
            database = self.state_module.SessionDB(db_path=home / "state.db")
            self.addCleanup(database.close)
            session_id = "runtime-row-mutation"
            database.create_session(session_id, source="cli")
            database.append_message(session_id, "user", "first")
            database.append_message(session_id, "assistant", "middle")
            database.append_message(session_id, "user", "tail")
            first_id = database.get_messages(session_id)[0]["id"]

            manager = self.plugins_module.PluginManager(scope_key=str(home))
            self.addCleanup(manager.unload)
            manager.discover_and_load()
            log_path = projection_path_from_prompt(manager, session_id)
            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                user_message="before row mutation",
                conversation_history=[],
            )
            before = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            before_message = next(
                record["message"]
                for record in before
                if record.get("record_type") == "message"
                and record["message"]["id"] == first_id
            )
            self.assertIsNone(before_message.get("display_metadata"))

            database.set_message_reaction(session_id, first_id, "👍")
            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                user_message="after row mutation",
                conversation_history=[],
            )

            after = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]
            after_message = next(
                record["message"]
                for record in after
                if record.get("record_type") == "message"
                and record["message"]["id"] == first_id
            )
            reactions = after_message["display_metadata"]["reactions"]
            self.assertEqual(reactions[0]["emoji"], "👍")
            self.assertTrue(manager.unload())
            database.close()


if __name__ == "__main__":
    unittest.main()
