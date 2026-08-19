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

    def test_assistant_selection_ignores_inactive_or_compacted_rows(self) -> None:
        module = load_verifier()
        inactive: dict[str, Any] = {
            "id": 2,
            "role": "assistant",
            "content": "RECOVERED",
            "active": 0,
            "compacted": 1,
        }

        def check_once(
            _child: object,
            _output: object,
            predicate: Any,
            **_kwargs: Any,
        ) -> Any:
            return predicate()

        with (
            unittest.mock.patch.object(module, "message_rows", return_value=[inactive]),
            unittest.mock.patch.object(module, "wait_for", side_effect=check_once),
        ):
            self.assertIsNone(
                module.wait_for_assistant(
                    object(),
                    deque(),
                    Path("/state.db"),
                    "s1",
                    1,
                    "RECOVERED",
                )
            )

        active = {**inactive, "active": 1, "compacted": 0}
        with (
            unittest.mock.patch.object(module, "message_rows", return_value=[active]),
            unittest.mock.patch.object(module, "wait_for", side_effect=check_once),
        ):
            self.assertEqual(
                module.wait_for_assistant(
                    object(),
                    deque(),
                    Path("/state.db"),
                    "s1",
                    1,
                    "RECOVERED",
                ),
                active,
            )

    def test_filler_phase_audits_every_assistant_row_for_tool_calls(self) -> None:
        module = load_verifier()
        terminal_row = {
            "id": 3,
            "role": "assistant",
            "tool_calls": None,
        }
        duplicate_call = '[{"name":"write_file","name":"read_file","arguments":"{}"}]'
        for malformed in ("{", {}, duplicate_call):
            with (
                self.subTest(malformed=malformed),
                self.assertRaisesRegex(AssertionError, "tool_calls"),
            ):
                module.require_tool_free_phase(
                    [
                        {
                            "id": 2,
                            "role": "assistant",
                            "tool_calls": malformed,
                        },
                        terminal_row,
                    ],
                    after_id=1,
                    through_id=3,
                    label="Filler 1",
                )

        with self.assertRaisesRegex(AssertionError, "tool evidence"):
            module.require_tool_free_phase(
                [
                    {
                        "id": 2,
                        "role": "tool",
                        "tool_call_id": "call-filler",
                    },
                    terminal_row,
                ],
                after_id=1,
                through_id=3,
                label="Filler 1",
            )

        module.require_tool_free_phase(
            [terminal_row],
            after_id=1,
            through_id=3,
            label="Filler 1",
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
            {"ok": 0, "total_count": 1, "matches_text": "PLG_NONCE_test"},
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

    def test_tool_result_rejects_boolean_counts(self) -> None:
        module = load_verifier()
        result = self.recovery_result(
            12,
            "call-1",
            json.dumps({"matches_text": "PLG_NONCE_test", "total_count": True}),
        )
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
        result["content"] = json.dumps(
            {"content": "1|PLG_NONCE_test", "total_lines": True}
        )
        self.assertFalse(
            module.is_successful_tool_result(
                result,
                tool_name="read_file",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=11,
                final_message_id=13,
            )
        )

    def test_tool_result_rejects_failed_exit_codes(self) -> None:
        module = load_verifier()
        for content in (
            {
                "exit_code": 1,
                "matches_text": "PLG_NONCE_test",
                "total_count": 1,
            },
            {
                "data": {
                    "exit_code": 1,
                    "matches_text": "PLG_NONCE_test",
                    "total_count": 1,
                },
                "success": True,
            },
        ):
            result = self.recovery_result(12, "call-1", json.dumps(content))
            with self.subTest(content=content):
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

    def test_recovery_tool_calls_reject_malformed_payloads(self) -> None:
        module = load_verifier()
        function = {
            "name": "search_files",
            "arguments": {"path": "/tmp/prolong/trajectory.jsonl"},
        }
        codex_call = {
            "call_id": "call-1",
            "function": function,
            "id": "call-1",
            "response_item_id": "fc-1",
            "type": "function",
        }
        self.assertEqual(
            module.require_recovery_tool_calls({"tool_calls": [codex_call]}),
            [codex_call],
        )
        malformed: tuple[Any, ...] = (
            "{",
            {},
            [None],
            ["not-a-call"],
            '[{"id":"first","id":"second","type":"function",'
            '"function":{"name":"search_files","arguments":{}}}]',
            [{"id": True, "type": "function", "function": function}],
            [{"id": "call-1", "type": "not-function", "function": function}],
            [
                {
                    "extra": "unsupported",
                    "id": "call-1",
                    "type": "function",
                    "function": function,
                }
            ],
            [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "search_files",
                        "arguments": '{"path":NaN}',
                    },
                }
            ],
            [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "search_files",
                        "arguments": '{"path":"/wrong","path":"/expected"}',
                    },
                }
            ],
            [{**codex_call, "id": "different"}],
            [{**codex_call, "response_item_id": True}],
        )
        for tool_calls in malformed:
            with (
                self.subTest(tool_calls=tool_calls),
                self.assertRaisesRegex(AssertionError, "tool_calls"),
            ):
                module.require_recovery_tool_calls({"tool_calls": tool_calls})
        self.assertEqual(module.require_recovery_tool_calls({"tool_calls": None}), [])
        self.assertEqual(module.require_recovery_tool_calls({"tool_calls": "[]"}), [])

    def test_seed_tool_path_requires_the_exact_persisted_hermes_shape(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/trajectory.jsonl")
        call: dict[str, Any] = {
            "name": "write_file",
            "arguments": json.dumps({"path": str(projection)}),
        }

        self.assertEqual(module.exact_seed_tool_path(call, projection), projection)
        codex_call: dict[str, Any] = {
            "call_id": "call-seed",
            "function": {
                "arguments": call["arguments"],
                "name": "write_file",
            },
            "id": "call-seed",
            "response_item_id": "fc-seed",
            "type": "function",
        }
        self.assertEqual(
            module.exact_seed_tool_path(codex_call, projection),
            projection,
        )
        for malformed in (
            {**call, "extra": True},
            {"name": True, "arguments": call["arguments"]},
            {
                "name": "write_file",
                "arguments": '{"path":"/wrong","path":"' + str(projection) + '"}',
            },
            {**codex_call, "id": "different"},
            {**codex_call, "response_item_id": True},
        ):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(AssertionError, "[Ss]eed tool call"):
                    module.exact_seed_tool_path(malformed, projection)

        duplicate_outer_call = (
            '[{"name":"write_file","name":"read_file","arguments":'
            + json.dumps(json.dumps({"path": str(projection)}))
            + "}]"
        )
        with self.assertRaisesRegex(AssertionError, "malformed JSON"):
            module.extract_tool_calls({"tool_calls": duplicate_outer_call})

    def test_tool_result_rejects_boolean_row_and_call_ids(self) -> None:
        module = load_verifier()
        content = json.dumps({"matches_text": "PLG_NONCE_test", "total_count": 1})
        boolean_call_id = self.recovery_result(12, "call-1", content)
        boolean_call_id["tool_call_id"] = True
        self.assertFalse(
            module.is_successful_tool_result(
                boolean_call_id,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="True",
                call_message_id=11,
                final_message_id=13,
            )
        )
        boolean_row_id = self.recovery_result(True, "call-1", content)
        self.assertFalse(
            module.is_successful_tool_result(
                boolean_row_id,
                tool_name="search_files",
                nonce="PLG_NONCE_test",
                call_id="call-1",
                call_message_id=0,
                final_message_id=2,
            )
        )

    def test_seed_evidence_rejects_same_id_result_outside_ordered_phase(self) -> None:
        module = load_verifier()
        seed_source = Path("/tmp/prolong-seed.txt")
        nonce = "PLG_NONCE_test"
        call_row = {
            "id": 10,
            "role": "assistant",
            "active": True,
            "compacted": False,
        }
        call = {
            "name": "read_file",
            "arguments": json.dumps({"path": str(seed_source)}),
        }
        failed_before_call = self.recovery_result(
            9,
            "call-seed",
            json.dumps({"error": "failed", "content": nonce, "total_lines": 1}),
        )
        successful_result = self.recovery_result(
            11,
            "call-seed",
            json.dumps({"content": nonce, "total_lines": 1}),
        )

        with self.assertRaisesRegex(AssertionError, "exactly one tool result"):
            module.require_seed_tool_evidence(
                [failed_before_call, successful_result],
                call_row=call_row,
                call=call,
                seed_source=seed_source,
                nonce=nonce,
                final_message_id=12,
            )

        false_claim = {
            "id": 13,
            "role": "user",
            "tool_call_id": "call-seed",
            "content": "not a result",
            "active": 1,
            "compacted": 0,
        }
        with self.assertRaisesRegex(AssertionError, "claiming the seed call ID"):
            module.require_seed_tool_evidence(
                [successful_result, false_claim],
                call_row=call_row,
                call=call,
                seed_source=seed_source,
                nonce=nonce,
                final_message_id=12,
            )

        self.assertEqual(
            module.require_seed_tool_evidence(
                [successful_result],
                call_row=call_row,
                call=call,
                seed_source=seed_source,
                nonce=nonce,
                final_message_id=12,
            ),
            successful_result,
        )

    def test_recovery_evidence_rejects_failed_result_before_success(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        calls = [
            self.recovery_call(10, "call-search", "search_files", projection),
            self.recovery_call(12, "call-read", "read_file", projection),
        ]
        rows = [
            self.recovery_result(
                11,
                "call-search",
                json.dumps(
                    {
                        "success": False,
                        "data": {"total_count": 1, "matches_text": nonce},
                        "error": "blocked",
                    }
                ),
            ),
            self.recovery_result(13, "call-read", f"44|MARKER={nonce}"),
        ]

        with self.assertRaisesRegex(AssertionError, "unsuccessful or malformed"):
            module.require_recovery_tool_evidence(
                rows,
                calls,
                projection=projection,
                nonce=nonce,
                final_message_id=14,
            )

    def test_recovery_evidence_rejects_inactive_or_compacted_call_rows(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        for active, compacted in ((False, False), (True, True), (0, 0), (1, 1)):
            call_row, call = self.recovery_call(
                10,
                "call-search",
                "search_files",
                projection,
            )
            call_row["active"] = active
            call_row["compacted"] = compacted
            with (
                self.subTest(active=active, compacted=compacted),
                self.assertRaisesRegex(AssertionError, "inactive or compacted"),
            ):
                module.require_recovery_tool_evidence(
                    [
                        self.recovery_result(
                            11,
                            "call-search",
                            json.dumps({"matches_text": nonce, "total_count": 1}),
                        )
                    ],
                    [(call_row, call)],
                    projection=projection,
                    nonce=nonce,
                    final_message_id=12,
                )

    def test_recovery_evidence_rejects_malformed_result_before_success(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        calls = [
            self.recovery_call(10, "call-read", "read_file", projection),
            self.recovery_call(12, "call-search", "search_files", projection),
        ]
        rows = [
            self.recovery_result(11, "call-read", json.dumps({"content": nonce})),
            self.recovery_result(
                13,
                "call-search",
                json.dumps({"total_count": 1, "matches_text": nonce}),
            ),
        ]

        with self.assertRaisesRegex(AssertionError, "unsuccessful or malformed"):
            module.require_recovery_tool_evidence(
                rows,
                calls,
                projection=projection,
                nonce=nonce,
                final_message_id=14,
            )

    def test_recovery_evidence_rejects_wrong_path_before_success(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        calls = [
            self.recovery_call(
                10,
                "call-search",
                "search_files",
                Path("/tmp/prolong/root/../root/trajectory.jsonl"),
            ),
            self.recovery_call(12, "call-read", "read_file", projection),
        ]
        rows = [
            self.recovery_result(
                11,
                "call-search",
                json.dumps({"total_count": 1, "matches_text": nonce}),
            ),
            self.recovery_result(13, "call-read", f"44|MARKER={nonce}"),
        ]

        with self.assertRaisesRegex(AssertionError, "exact advertised path"):
            module.require_recovery_tool_evidence(
                rows,
                calls,
                projection=projection,
                nonce=nonce,
                final_message_id=14,
            )

    def test_recovery_evidence_rejects_out_of_phase_or_unmatched_results(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        calls = [self.recovery_call(10, "call-search", "search_files", projection)]
        success = self.recovery_result(
            11,
            "call-search",
            json.dumps({"total_count": 1, "matches_text": nonce}),
        )
        extras = (
            self.recovery_result(9, "call-search", '{"error":"failed"}'),
            self.recovery_result(21, "call-search", '{"error":"failed"}'),
            self.recovery_result(12, "unknown-call", '{"error":"failed"}'),
        )
        for extra in extras:
            with (
                self.subTest(extra=extra),
                self.assertRaisesRegex(AssertionError, "result"),
            ):
                module.require_recovery_tool_evidence(
                    [success, extra],
                    calls,
                    projection=projection,
                    nonce=nonce,
                    recovery_user_id=5,
                    final_message_id=20,
                )

    def test_recovery_evidence_accepts_successful_ordered_calls(self) -> None:
        module = load_verifier()
        projection = Path("/tmp/prolong/root/trajectory.jsonl")
        nonce = "PLG_NONCE_test"
        calls = [
            self.recovery_call(10, "call-search", "search_files", projection),
            self.recovery_call(12, "call-read", "read_file", projection),
        ]
        rows = [
            self.recovery_result(
                11,
                "call-search",
                json.dumps({"total_count": 1, "matches_text": nonce}),
            ),
            self.recovery_result(13, "call-read", f"44|MARKER={nonce}"),
        ]

        evidence = module.require_recovery_tool_evidence(
            rows,
            calls,
            projection=projection,
            nonce=nonce,
            final_message_id=14,
        )

        self.assertEqual(
            [(call["id"], result["id"]) for _, call, result in evidence],
            [("call-search", 11), ("call-read", 13)],
        )

    @staticmethod
    def recovery_call(
        row_id: int,
        call_id: str,
        tool_name: str,
        path: Path,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return (
            {
                "id": row_id,
                "role": "assistant",
                "active": True,
                "compacted": False,
            },
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": {"path": str(path)},
                },
            },
        )

    @staticmethod
    def recovery_result(row_id: int, call_id: str, content: str) -> dict[str, Any]:
        return {
            "id": row_id,
            "role": "tool",
            "tool_call_id": call_id,
            "content": content,
            "active": True,
            "compacted": False,
        }

    def test_projection_idle_requires_a_private_read_only_regular_file(self) -> None:
        module = load_verifier()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            projection = root / "trajectory.jsonl"
            projection.write_text("{}\n", encoding="utf-8")
            projection.chmod(0o600)
            self.assertFalse(module.projection_is_idle(projection))
            projection.chmod(0o400)
            self.assertTrue(module.projection_is_idle(projection))
            sibling = root / "linked.jsonl"
            os.link(projection, sibling)
            self.assertFalse(module.projection_is_idle(projection))
            sibling.unlink()
            self.assertTrue(module.projection_is_idle(projection))
            symlink = root / "symlink.jsonl"
            symlink.symlink_to(projection)
            self.assertFalse(module.projection_is_idle(symlink))

    def test_receipt_write_is_exclusive_private_and_cleanup_is_verified(self) -> None:
        module = load_verifier()
        import stat

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

        with unittest.mock.patch.object(module, "pexpect", FailingPexpect, create=True):
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
