from __future__ import annotations

import importlib
import os
import tempfile
import unittest
from pathlib import Path

from tests.hermes_prolong.test_controller import FakeReader, create_private_anchor
from tests.hermes_prolong.test_plugin_registration import load_plugin_module


class FailOpenSafetyTests(unittest.TestCase):
    def test_prompt_fails_open_for_malformed_session_ids(self) -> None:
        module = load_plugin_module()

        class UnexpectedController:
            def projection_path(self, session_id: str) -> Path:
                raise AssertionError(
                    f"malformed session ID reached the controller: {session_id!r}"
                )

        for session_id in ("../escape", "space separated", 123):
            with self.subTest(session_id=session_id):
                rendered = module.build_prompt(
                    {"session_id": session_id},
                    controller=UnexpectedController(),
                )

                self.assertIn("unavailable", rendered.casefold())
                self.assertNotIn("trajectory.jsonl", rendered)

    def test_session_start_ignores_a_malformed_session_id(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                result = controller.on_session_start(session_id="../escape")

            self.assertIsNone(result)
            self.assertFalse(root.exists())
            controller.close()

    def test_projection_path_never_advertises_a_dangling_symlink(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.controller")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "plugin-data" / "prolong" / "sessions"
            anchor_directory = create_private_anchor(root)
            log_path = anchor_directory / "trajectory.jsonl"
            log_path.symlink_to(anchor_directory / "missing")
            controller = module.ProlongController(
                reader=FakeReader(),
                projection_root=root,
            )

            try:
                with self.assertLogs("hermes.plugins.prolong", level="ERROR"):
                    resolved = controller.projection_path("s1")

                self.assertIn(".unavailable", resolved.parts)
                self.assertFalse(resolved.exists())
                self.assertTrue(os.path.lexists(log_path))
            finally:
                if os.path.lexists(log_path):
                    log_path.unlink()
                controller.close()


if __name__ == "__main__":
    unittest.main()
