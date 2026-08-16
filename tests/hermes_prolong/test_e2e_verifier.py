"""Regression tests for the real-session PRO-LONG verifier."""

from __future__ import annotations

import builtins
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from collections import deque
from pathlib import Path
from types import ModuleType
from typing import Any


VERIFIER_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "verify-hermes-prolong-e2e.py"
)


def load_verifier() -> ModuleType:
    spec = importlib.util.spec_from_file_location("prolong_e2e_verifier", VERIFIER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {VERIFIER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class E2EVerifierTests(unittest.TestCase):
    def test_model_free_helpers_import_without_optional_pexpect(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "prolong_e2e_no_pexpect", VERIFIER_PATH
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        original_import = builtins.__import__

        def import_without_pexpect(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == "pexpect":
                raise ModuleNotFoundError("pexpect intentionally unavailable")
            return original_import(name, *args, **kwargs)

        with unittest.mock.patch("builtins.__import__", import_without_pexpect):
            spec.loader.exec_module(module)

    def test_nonce_seed_survives_file_tool_limits_but_is_hidden_from_summary_input(
        self,
    ) -> None:
        module = load_verifier()
        nonce = "PLG_NONCE_regression"

        source = module.build_seed_source(nonce)
        lines = source.splitlines()
        rendered_tool_result = "\n".join(
            f"{line_number}|{line}" for line_number, line in enumerate(lines, start=1)
        )
        marker_start = rendered_tool_result.index(nonce)
        marker_end = marker_start + len(nonce)

        self.assertEqual(
            len(lines),
            module.SEED_LEADING_LINE_COUNT + 1 + module.SEED_TRAILING_LINE_COUNT,
        )
        self.assertEqual(
            lines[: module.SEED_LEADING_LINE_COUNT],
            ["A" * module.SEED_LINE_WIDTH] * module.SEED_LEADING_LINE_COUNT,
        )
        self.assertEqual(
            lines[-module.SEED_TRAILING_LINE_COUNT :],
            ["B" * module.SEED_LINE_WIDTH] * module.SEED_TRAILING_LINE_COUNT,
        )
        expected_marker_start = sum(
            len(f"{line_number}|{'A' * module.SEED_LINE_WIDTH}\n")
            for line_number in range(1, module.SEED_LEADING_LINE_COUNT + 1)
        ) + len(f"{module.SEED_LEADING_LINE_COUNT + 1}|MARKER=")
        expected_trailing_width = sum(
            len(f"{line_number}|{'B' * module.SEED_LINE_WIDTH}") + 1
            for line_number in range(
                module.SEED_LEADING_LINE_COUNT + 2,
                len(lines) + 1,
            )
        )
        self.assertEqual(marker_start, expected_marker_start)
        self.assertEqual(
            len(rendered_tool_result) - marker_end,
            expected_trailing_width,
        )

        # Hermes's bounded tool rendering retains roughly a 4k head and 1.5k
        # tail. Keep the nonce outside both windows so PTY clipping cannot make
        # a leaked marker look like successful PRO-LONG recovery.
        self.assertGreater(marker_start, 4_000)
        self.assertGreater(len(rendered_tool_result) - marker_end, 1_500)

    def test_compression_capture_discards_prior_bounded_child_output(self) -> None:
        module = load_verifier()
        output = deque(["seed output", "filler output"], maxlen=64)

        class RecordingChild:
            command: str | None = None

            def sendline(self, command: str) -> None:
                self.command = command
                self.output_when_sent = list(output)
                output.append("compression output")

        child = RecordingChild()

        module.start_compression_capture(child, output)

        self.assertEqual(child.command, "/compress")
        self.assertEqual(child.output_when_sent, [])
        self.assertEqual("".join(output), "compression output")

    def test_source_revision_is_unknown_for_non_git_hermes_source(self) -> None:
        module = load_verifier()
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(
                module.source_revision(Path(directory), os.environ.copy()),
                "unknown",
            )

    def test_locate_projection_raises_when_multiple_plugins_match(self) -> None:
        module = load_verifier()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            for plugin_name in ("first", "second"):
                projection = (
                    home
                    / "plugin-data"
                    / plugin_name
                    / "sessions"
                    / "session-1"
                    / "trajectory.jsonl"
                )
                projection.parent.mkdir(parents=True)
                projection.write_text("{}\n", encoding="utf-8")

            with self.assertRaisesRegex(
                RuntimeError, "Ambiguous trajectory projection"
            ):
                module.locate_projection(home, "session-1")

    def test_projected_seed_selection_uses_canonical_message_identity(self) -> None:
        module = load_verifier()
        nonce = "PLG_NONCE_test"
        records = [
            {
                "record_type": "message",
                "message": {"id": 10, "role": "tool", "content": nonce},
            },
            {
                "record_type": "message",
                "message": {"id": 20, "role": "tool", "content": nonce},
            },
        ]

        selected = module.projected_seed_messages(records, 10, nonce)

        self.assertEqual([message["id"] for message in selected], [10])

    def test_plugin_listing_requires_exact_enabled_user_entry(self) -> None:
        module = load_verifier()
        entry = module.require_plugin_entry(
            [
                {
                    "name": "prolong",
                    "status": "enabled",
                    "source": "user",
                    "version": "0.1.0",
                }
            ]
        )
        self.assertEqual(entry["name"], "prolong")
        with self.assertRaises(AssertionError):
            module.require_plugin_entry({"description": "prolong"})
        with self.assertRaises(AssertionError):
            module.require_plugin_entry(
                [{"name": "prolong", "status": "enabled", "source": "bundled"}]
            )

    def test_tool_result_requires_ordered_success_and_exact_lexical_path(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        call = {
            "id": "call-1",
            "type": "function",
            "function": {
                "name": "search_files",
                "arguments": {
                    "path": str(projection),
                    "pattern": "MARKER=",
                },
            },
        }
        result = {
            "id": 12,
            "role": "tool",
            "tool_call_id": "call-1",
            "content": (
                '{"success":true,"data":{"total_count":1,"matches":["PLG_NONCE_test"]},"error":null}'
            ),
            "active": True,
            "compacted": False,
        }
        self.assertTrue(
            module.is_successful_tool_result(
                result,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        result["content"] = json.dumps(
            {"total_count": 1, "matches_text": "PLG_NONCE_test"}
        )
        self.assertTrue(
            module.is_successful_tool_result(
                result,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        result["content"] = "44|MARKER=PLG_NONCE_test"
        self.assertTrue(
            module.is_successful_tool_result(
                result,
                tool_name="read_file",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        self.assertEqual(module.exact_tool_path(call, projection), projection)
        alias: dict[str, Any] = {
            "function": {
                "arguments": {"path": "/tmp/prolong/root/../root/trajectory.jsonl"}
            }
        }
        with self.assertRaises(AssertionError):
            module.exact_tool_path(alias, projection)
        result["content"] = '{"matches":[],"error":"blocked"}'
        self.assertFalse(
            module.is_successful_tool_result(
                result,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        result["content"] = "ERROR: failed to read PLG_NONCE_test"
        self.assertFalse(
            module.is_successful_tool_result(
                result,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        result["content"] = json.dumps({"status": "aborted", "data": "PLG_NONCE_test"})
        self.assertFalse(
            module.is_successful_tool_result(
                result,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )
        rejected = (
            {
                "success": False,
                "total_count": 1,
                "matches_text": "PLG_NONCE_test",
            },
            {
                "success": True,
                "data": {
                    "total_count": 1,
                    "matches_text": "PLG_NONCE_test",
                    "error": "blocked",
                },
            },
            {"success": True, "data": {"value": "PLG_NONCE_test"}},
        )
        for payload in rejected:
            with self.subTest(payload=payload):
                result["content"] = json.dumps(payload)
                self.assertFalse(
                    module.is_successful_tool_result(
                        result,
                        tool_name="search_files",
                        nonce="PLG_NONCE_test",
                        call_id="call-1",
                        call_message_id=11,
                        final_message_id=13,
                    )
                )

    def test_receipt_write_is_exclusive_private_and_cleanup_is_verified(self) -> None:
        module = load_verifier()
        import stat
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / "receipt.json"
            module.write_secure_json(receipt, {"status": "passed"})
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
            self.assertEqual(json.loads(receipt.read_text()), {"status": "passed"})
            with self.assertRaises(FileExistsError):
                module.write_secure_json(receipt, {"status": "failed"})

            isolated = root / "isolated"
            isolated.mkdir()
            (isolated / "credential").write_text("opaque")
            module.remove_tree_verified(isolated)
            self.assertFalse(isolated.exists())
            dangling = root / "dangling"
            dangling.symlink_to(root / "missing-target", target_is_directory=True)
            self.assertTrue(module.path_lexists(dangling))
            with self.assertRaises(RuntimeError):
                module.remove_tree_verified(dangling)

    def test_credential_copy_keeps_only_openai_codex_records(self) -> None:
        module = load_verifier()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            destination = root / "destination"
            source.mkdir(mode=0o700)
            destination.mkdir(mode=0o700)
            credential_path = source / "auth.json"
            credential_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "active_provider": None,
                        "credential_pool": {
                            "openai-codex": [{"access_token": "codex"}],
                            "openrouter": [{"access_token": "unrelated"}],
                        },
                        "providers": {
                            "openai-codex": {"access_token": "codex"},
                            "openrouter": {"access_token": "unrelated"},
                        },
                    }
                ),
                encoding="utf-8",
            )
            credential_path.chmod(0o600)

            module.copy_credentials(source, destination)

            copied = json.loads((destination / "auth.json").read_text())
            self.assertEqual(set(copied["credential_pool"]), {"openai-codex"})
            self.assertEqual(set(copied["providers"]), {"openai-codex"})
            self.assertNotIn("unrelated", json.dumps(copied))

    def test_credential_copy_rejects_auth_without_openai_codex(self) -> None:
        module = load_verifier()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            destination = root / "destination"
            source.mkdir(mode=0o700)
            destination.mkdir(mode=0o700)
            credential_path = source / "auth.json"
            credential_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "active_provider": "openrouter",
                        "credential_pool": {
                            "openrouter": [{"access_token": "unrelated"}]
                        },
                        "providers": {"openrouter": {"access_token": "unrelated"}},
                    }
                ),
                encoding="utf-8",
            )
            credential_path.chmod(0o600)

            with self.assertRaisesRegex(RuntimeError, "No OpenAI Codex credentials"):
                module.copy_credentials(source, destination)

            self.assertFalse((destination / "auth.json").exists())

    def test_spawn_failure_records_the_concrete_exception(self) -> None:
        module = load_verifier()
        evidence: dict[str, object] = {"status": "initializing"}

        class FailingPexpect:
            @staticmethod
            def spawn(*args, **kwargs):
                raise OSError("pty unavailable")

        setattr(module, "pexpect", FailingPexpect)
        with self.assertRaisesRegex(OSError, "pty unavailable"):
            module.spawn_hermes(
                Path("/hermes"),
                Path("/repo"),
                {},
                evidence,
            )

        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["error_type"], "OSError")
        self.assertEqual(evidence["error"], "pty unavailable")


if __name__ == "__main__":
    unittest.main()
