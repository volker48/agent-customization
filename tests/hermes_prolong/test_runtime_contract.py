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
    def test_plugin_manager_loads_hooks_and_projects_real_session_lineage(self) -> None:
        sys.path.insert(0, str(HERMES_SOURCE))
        plugins_module = importlib.import_module("hermes_cli.plugins")
        state_module = importlib.import_module("hermes_state")
        plugin_manager = plugins_module.PluginManager
        session_database = state_module.SessionDB

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
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
                message="query",
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
        sys.path.insert(0, str(HERMES_SOURCE))
        plugins_module = importlib.import_module("hermes_cli.plugins")
        state_module = importlib.import_module("hermes_state")

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plugins_dir = home / "plugins"
            plugins_dir.mkdir(mode=0o700)
            (plugins_dir / "prolong").symlink_to(
                PLUGIN_SOURCE, target_is_directory=True
            )
            (home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - prolong\n",
                encoding="utf-8",
            )
            database = state_module.SessionDB(db_path=home / "state.db")
            session_id = "runtime-in-place"
            database.create_session(session_id, "cli")
            database.append_message(session_id, "user", "full fidelity nonce")
            database.append_message(session_id, "assistant", "pre-compression answer")

            manager = plugins_module.PluginManager(scope_key=str(home))
            manager.discover_and_load()
            log_path = projection_path_from_prompt(manager, session_id)
            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                message="before compression",
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
                message="after compression",
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
        sys.path.insert(0, str(HERMES_SOURCE))
        try:
            plugins_module = importlib.import_module("hermes_cli.plugins")
            state_module = importlib.import_module("hermes_state")
        finally:
            if sys.path[0] == HERMES_SOURCE:
                sys.path.pop(0)

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plugin_dir = home / "plugins" / "prolong"
            plugin_dir.parent.mkdir(parents=True)
            plugin_dir.symlink_to(PLUGIN_SOURCE, target_is_directory=True)
            (home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - prolong\n",
                encoding="utf-8",
            )
            setattr(state_module, "_state_db", None)
            setattr(state_module, "_state_db_path", None)
            setattr(state_module, "_state_db_failed", False)
            os.environ["HERMES_HOME"] = str(home)
            database = state_module.SessionDB(db_path=home / "state.db")
            session_id = "runtime-row-mutation"
            database.create_session(session_id, source="cli")
            database.append_message(session_id, "user", "first")
            database.append_message(session_id, "assistant", "middle")
            database.append_message(session_id, "user", "tail")
            first_id = database.get_messages(session_id)[0]["id"]

            manager = plugins_module.PluginManager(scope_key=str(home))
            manager.discover_and_load()
            log_path = projection_path_from_prompt(manager, session_id)
            manager.invoke_hook(
                "pre_llm_call",
                session_id=session_id,
                messages=[],
                tools=[],
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
                messages=[],
                tools=[],
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
