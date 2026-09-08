import json
import pathlib
import sqlite3
import sys
import unittest
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from fakes import FakeStore


class AnalyzerTests(unittest.TestCase):

    def test_tool_call_fingerprints_canonicalize_arguments_without_exposure(self):
        from trajectory_analyzer.analyzer import _tool_call_fingerprints

        calls = [
            {
                "name": "read_file",
                "arguments": '{"path":"private.txt","token":"SECRET_TOOL_ARG_456"}',
            },
            {
                "name": "read_file",
                "arguments": {"token": "SECRET_TOOL_ARG_456", "path": "private.txt"},
            },
        ]

        fingerprints = _tool_call_fingerprints(calls)

        self.assertEqual("read_file", fingerprints[0][0])
        self.assertEqual("read_file", fingerprints[1][0])
        self.assertEqual(fingerprints[0][1], fingerprints[1][1])
        self.assertEqual(16, len(fingerprints[0][1]))
        self.assertNotIn("SECRET_TOOL_ARG_456", repr(fingerprints))

    def test_thirteen_tool_calls_produce_measured_high_fanout_finding(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": {"path": f"private-{index}.txt"}}
            for index in range(13)
        ]
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual(1, len(report["findings"]))
        finding = report["findings"][0]
        self.assertEqual("high_tool_fanout_per_turn", finding["code"])
        self.assertEqual(13, finding["tool_calls"])
        self.assertEqual("measured_exposure", finding["impact"]["kind"])
        self.assertNotIn("private-0.txt", repr(finding))

    def test_twelve_tool_calls_are_silent(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": {"path": f"private-{index}.txt"}}
            for index in range(12)
        ]
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_three_identical_tool_calls_produce_benchmark_required_repeat_finding(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": {"path": "private.txt", "offset": 10}}
            for _ in range(3)
        ]
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual(1, len(report["findings"]))
        finding = report["findings"][0]
        self.assertEqual("repeated_exact_tool_call", finding["code"])
        self.assertEqual("read_file", finding["tool_name"])
        self.assertEqual(16, len(finding["fingerprint"]))
        self.assertEqual(3, finding["repeat_count"])
        self.assertEqual("benchmark_required", finding["impact"]["kind"])
        self.assertNotIn("arguments", finding)
        self.assertNotIn("private.txt", repr(finding))

    def test_two_identical_tool_calls_are_silent(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": {"path": "private.txt", "offset": 10}}
            for _ in range(2)
        ]
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_distinct_tool_arguments_do_not_collapse_into_repeats(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": {"path": "private.txt", "offset": offset}}
            for offset in (0, 10, 20)
        ]
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_malformed_tool_call_data_is_skipped(self):
        from trajectory_analyzer.analyzer import _tool_call_fingerprints

        fingerprints = _tool_call_fingerprints(
            [
                {"name": "read_file", "arguments": "not JSON"},
                {"name": "read_file", "arguments": []},
                {"name": "read_file", "arguments": {"invalid": object()}},
                None,
            ]
        )

        self.assertEqual((), fingerprints)

    def test_duplicate_json_argument_keys_are_skipped_without_false_repeat(self):
        from trajectory_analyzer.analyzer import analyze

        calls = [
            {"name": "read_file", "arguments": '{"path":"private.txt","path":"other.txt"}'},
            {"name": "read_file", "arguments": {"path": "other.txt"}},
            {"name": "read_file", "arguments": {"path": "other.txt"}},
        ]

        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "tool_calls": calls},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_nonstandard_json_constants_in_tool_calls_fail_soft(self):
        from trajectory_analyzer.analyzer import analyze

        valid_call = '{"name":"read_file","arguments":{"path":"private.txt"}}'
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                report = analyze(
                    FakeStore(
                        sessions=[{"id": "s-1", "source": "telegram"}],
                        messages=[
                            {"session_id": "s-1", "role": "user", "active": 1},
                            {
                                "session_id": "s-1",
                                "role": "assistant",
                                "active": 1,
                                "tool_calls": f"[{valid_call},{valid_call},{valid_call},{constant}]",
                            },
                        ],
                    )
                )

                self.assertEqual([], report["findings"])

    def test_content_embedded_duplicate_json_argument_keys_are_skipped_without_false_repeat(self):
        from trajectory_analyzer.analyzer import analyze

        content = (
            '{"tool_calls":['
            '{"name":"read_file","arguments":{"path":"private.txt","path":"other.txt"}},'
            '{"name":"read_file","arguments":{"path":"other.txt"}},'
            '{"name":"read_file","arguments":{"path":"other.txt"}}'
            ']}'
        )

        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "content": content},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_assistant_json_content_is_not_interpreted_as_persisted_tool_calls(self):
        from trajectory_analyzer.analyzer import analyze

        private_name = "PRIVATE_ASSISTANT_RESPONSE_FRAGMENT"
        content = json.dumps(
            {
                "tool_calls": [
                    {"name": private_name, "arguments": {"example": "value"}}
                    for _ in range(13)
                ]
            }
        )
        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {
                        "session_id": "s-1",
                        "role": "assistant",
                        "active": 1,
                        "content": content,
                        "tool_calls": None,
                    },
                ],
            )
        )

        self.assertEqual([], report["findings"])
        self.assertNotIn(private_name, repr(report))

    def test_deeply_nested_content_embedded_tool_calls_fail_soft(self):
        from trajectory_analyzer.analyzer import analyze

        content = '{"tool_calls":[],"nested":' + '[' * 1_500 + 'null' + ']' * 1_500 + '}'

        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1, "content": content},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_deeply_nested_tool_arguments_fail_soft(self):
        from trajectory_analyzer.analyzer import _tool_call_fingerprints

        deeply_nested_json = '{"nested":' * 1_000 + 'null' + '}' * 1_000
        deeply_nested_dict = None
        for _ in range(1_000):
            deeply_nested_dict = {"nested": deeply_nested_dict}

        fingerprints = _tool_call_fingerprints(
            [
                {"name": "read_file", "arguments": deeply_nested_json},
                {"name": "read_file", "arguments": deeply_nested_dict},
            ]
        )

        self.assertEqual((), fingerprints)

    def test_empty_store_returns_the_versioned_zero_report(self):
        from trajectory_analyzer.analyzer import analyze

        generated_at = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
        report = analyze(FakeStore(), days=30, source=None, now=generated_at)

        self.assertEqual(
            {
                "schema_version": 1,
                "days": 30,
                "source_filter": None,
                "generated_at": generated_at.timestamp(),
                "sessions_analyzed": 0,
                "turns_analyzed": 0,
                "summary": {
                    "finding_count": 0,
                    "sessions_with_findings": 0,
                    "by_code": {},
                    "by_severity": {},
                    "estimated_avoidable_tokens": 0,
                    "benchmark_required_tokens": 0,
                    "methodology_note": (
                        "Assistant steps are not an exact per-turn or provider-call mapping; "
                        "persisted session-level API call counts cannot be attributed "
                        "to individual turns."
                    ),
                },
                "findings": [],
            },
            report,
        )

    def test_analyze_rejects_invalid_windows_before_accessing_the_store(self):
        from trajectory_analyzer.analyzer import analyze

        generated_at = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
        for days in (0, -1, 10**100):
            with self.subTest(days=days):
                store = FakeStore()

                with self.assertRaisesRegex(ValueError, "days must be between 1 and"):
                    analyze(store, days=days, now=generated_at)

                self.assertEqual([], store.session_calls)
                self.assertEqual([], store.message_calls)

    def test_threshold_defaults_are_explicit_and_immutable(self):
        from trajectory_analyzer.analyzer import AnalyzerThresholds

        thresholds = AnalyzerThresholds()
        self.assertEqual(8, thresholds.assistant_steps_per_turn)
        self.assertEqual(12, thresholds.tool_calls_per_turn)
        self.assertEqual(3, thresholds.repeated_exact_tool_call_count)
        self.assertEqual(40_000, thresholds.large_tool_payload_bytes)
        self.assertEqual(100_000, thresholds.large_system_prompt_bytes)
        self.assertEqual(2, thresholds.minimum_later_steps_for_retention)
        self.assertEqual(100_000, thresholds.low_cache_reuse_min_workload_tokens)
        self.assertEqual(0.50, thresholds.low_cache_reuse_ratio)
        self.assertEqual(10, thresholds.same_model_child_min_api_calls)
        with self.assertRaises(FrozenInstanceError):
            thresholds.assistant_steps_per_turn = 9

    def test_retained_large_tool_payload_reports_observed_bytes_and_estimated_workload(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"id": "user-1", "session_id": "session-1", "role": "user", "active": 1},
                    {
                        "id": "tool-1",
                        "session_id": "session-1",
                        "role": "tool",
                        "tool_name": "web_extract",
                        "content": "PAYLOAD_SENTINEL" + "x" * (40_001 - len("PAYLOAD_SENTINEL")),
                        "active": 1,
                    },
                    {"id": "assistant-1", "session_id": "session-1", "role": "assistant", "active": 1},
                    {"id": "assistant-2", "session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual(1, len(report["findings"]))
        finding = report["findings"][0]
        self.assertEqual("large_tool_payload", finding["code"])
        self.assertEqual("session-1", finding["session_id"])
        self.assertEqual(1, finding["turn_index"])
        self.assertEqual("tool-1", finding["tool_message_id"])
        self.assertEqual("web_extract", finding["tool_name"])
        self.assertEqual(40_001, finding["observed"]["payload_bytes"])
        self.assertEqual(2, finding["observed"]["later_assistant_steps"])
        self.assertEqual("estimated_avoidable_workload", finding["impact"]["kind"])
        self.assertEqual(20_002, finding["impact"]["tokens"])
        self.assertEqual(20_002, report["summary"]["estimated_avoidable_tokens"])
        self.assertNotIn("PAYLOAD_SENTINEL", str(report))

    def test_large_tool_payload_nests_observed_evidence_without_flat_duplicates(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"id": "user-1", "session_id": "session-1", "role": "user", "active": 1},
                    {"id": "tool-1", "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        finding = report["findings"][0]
        self.assertEqual(
            {"payload_bytes": 40_001, "later_assistant_steps": 2},
            finding["observed"],
        )
        self.assertNotIn("payload_bytes", finding)
        self.assertNotIn("later_assistant_steps", finding)

    def test_tool_payload_at_the_40_000_byte_threshold_is_silent(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {
                        "id": "tool-1",
                        "session_id": "session-1",
                        "role": "tool",
                        "tool_name": "web_extract",
                        "content": "x" * 40_000,
                        "active": 1,
                    },
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_large_tool_payload_with_one_later_assistant_step_is_silent(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"id": "tool-1", "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_large_tool_payload_at_turn_end_is_silent(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"id": "tool-1", "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_assistant_steps_in_the_next_user_turn_are_not_counted(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"id": "tool-1", "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual([], report["findings"])

    def test_large_payload_detection_does_not_rescan_prior_sessions(self):
        from trajectory_analyzer.analyzer import (
            AnalyzerThresholds,
            MessageRecord,
            TurnRecord,
            _large_tool_payload_findings,
        )

        class CountingSessionId(str):
            comparisons = 0

            def __eq__(self, other):
                type(self).comparisons += 1
                return super().__eq__(other)

            __hash__ = str.__hash__

        payload = "x" * 40_001
        messages = []
        turns = []
        for index in range(100):
            session_id = CountingSessionId(f"session-{index}")
            messages.extend(
                [
                    MessageRecord(session_id, f"user-{index}", "user", None, None, ()),
                    MessageRecord(
                        session_id,
                        f"tool-{index}",
                        "tool",
                        "web_extract",
                        payload,
                        (),
                    ),
                    MessageRecord(session_id, None, "assistant", None, None, ()),
                    MessageRecord(session_id, None, "assistant", None, None, ()),
                ]
            )
            turns.append(TurnRecord(session_id, 1, f"user-{index}", 2, ()))

        findings = _large_tool_payload_findings(
            tuple(messages), tuple(turns), AnalyzerThresholds()
        )

        self.assertEqual(100, len(findings))
        self.assertLess(CountingSessionId.comparisons, 1_000)

    def test_multibyte_tool_content_is_measured_in_utf8_bytes(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"id": "tool-1", "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "é" * 20_001, "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual(40_002, report["findings"][0]["observed"]["payload_bytes"])
        self.assertEqual(20_002, report["findings"][0]["impact"]["tokens"])

    def test_numeric_turn_user_and_tool_message_ids_are_retained_as_evidence(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"id": 13, "session_id": "session-1", "role": "user", "active": 1},
                    {"id": 17, "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        finding = report["findings"][0]
        self.assertEqual(13, finding["turn_user_message_id"])
        self.assertEqual(17, finding["tool_message_id"])

    def test_eight_assistant_steps_is_silent(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "role": "user", "active": 1},
                    *[
                        {"session_id": "s-1", "role": "assistant", "active": 1}
                        for _ in range(8)
                    ],
                ],
            )
        )

        self.assertEqual([], report["findings"])
        self.assertEqual(1, report["turns_analyzed"])

    def test_malformed_rows_fail_soft_without_exposing_content(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{}, {"id": "s-1", "source": "telegram"}],
                messages=[
                    {"session_id": "s-1", "active": 1, "content": "do not report"},
                    {"role": "assistant", "active": 1, "content": "do not report"},
                    {"session_id": [], "role": "assistant", "active": 1},
                    {"session_id": "s-1", "role": {}, "active": 1},
                    {"session_id": "s-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual(1, report["sessions_analyzed"])
        self.assertEqual(0, report["turns_analyzed"])
        self.assertEqual([], report["findings"])

    def test_sqlite_persisted_standard_tool_calls_produce_fanout_and_repeat_findings(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT,
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            INSERT INTO sessions (id, source, started_at) VALUES ('persisted-session', 'telegram', 1788048000.0);
            """
        )
        calls = [
            {
                "id": f"call-{index}",
                "type": "function",
                "function": {
                    "name": "read_file",
                    "arguments": json.dumps({"path": "private-repeat.txt" if index < 3 else f"private-{index}.txt"}),
                },
            }
            for index in range(13)
        ]
        connection.execute(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (1, "persisted-session", "user", 1, 1788048001.0, "private prompt", None, None),
        )
        connection.execute(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (2, "persisted-session", "assistant", 1, 1788048002.0, None, None, json.dumps(calls)),
        )

        report = analyze(
            SqliteStore(connection), now=datetime(2026, 8, 30, tzinfo=timezone.utc)
        )

        findings = {finding["code"]: finding for finding in report["findings"]}
        self.assertEqual(13, findings["high_tool_fanout_per_turn"]["tool_calls"])
        self.assertEqual(3, findings["repeated_exact_tool_call"]["repeat_count"])
        self.assertEqual("read_file", findings["repeated_exact_tool_call"]["tool_name"])
        self.assertNotIn("private-repeat.txt", repr(report))
        self.assertNotIn("private prompt", repr(report))

    def test_sqlite_store_filters_source_and_inactive_rows_in_its_two_queries(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT,
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            INSERT INTO sessions (id, source, started_at) VALUES ('telegram-session', 'telegram', 1788048000.0);
            INSERT INTO sessions (id, source, started_at) VALUES ('other-session', 'discord', 1788048000.0);
            INSERT INTO messages VALUES
                (1, 'telegram-session', 'user', 1, 1788048001.0, 'private prompt', NULL, NULL);
            INSERT INTO messages VALUES
                (2, 'telegram-session', 'assistant', 1, 1788048002.0, 'private response', NULL, NULL);
            INSERT INTO messages VALUES
                (3, 'telegram-session', 'assistant', 0, 1788048003.0, 'inactive response', NULL, NULL);
            INSERT INTO messages VALUES
                (4, 'other-session', 'user', 1, 1788048004.0, 'other prompt', NULL, NULL);
            """
        )
        statements = []
        connection.set_trace_callback(statements.append)

        report = analyze(
            SqliteStore(connection),
            source="telegram",
            now=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )

        selects = [
            statement for statement in statements if statement.lstrip().upper().startswith("SELECT")
        ]
        self.assertEqual(2, len(selects))
        self.assertIn("source =", selects[0])
        self.assertIn("active = 1", selects[1])
        self.assertEqual(1, report["sessions_analyzed"])
        self.assertEqual(1, report["turns_analyzed"])
        self.assertEqual([], report["findings"])

    def test_sqlite_message_query_uses_fixed_parameters_for_many_sessions(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        class RecordingConnection:
            def __init__(self, connection):
                self.connection = connection
                self.calls = []

            def execute(self, query, parameters=()):
                self.calls.append((query, parameters))
                return self.connection.execute(query, parameters)

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT,
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            """
        )
        connection.executemany(
            "INSERT INTO sessions (id, source, started_at) VALUES (?, 'telegram', 1788048000.0)",
            [(f"session-{index}",) for index in range(1_001)],
        )
        recorded = RecordingConnection(connection)
        generated_at = datetime(2026, 8, 30, tzinfo=timezone.utc)

        analyze(SqliteStore(recorded), source="telegram", now=generated_at)

        selects = [call for call in recorded.calls if call[0].lstrip().upper().startswith("SELECT")]
        self.assertEqual(2, len(selects))
        message_query, message_parameters = selects[1]
        self.assertIn("JOIN sessions AS s", message_query)
        self.assertIn("m.active = 1", message_query)
        self.assertIn("m.tool_calls", message_query)
        self.assertIn("s.started_at >= ?", message_query)
        self.assertIn("s.source = ?", message_query)
        self.assertEqual(2, len(message_parameters))

    def test_large_initial_prompt_reports_token_estimate_method_and_cache_context_caveat(self):
        from trajectory_analyzer.analyzer import analyze

        prompt = "x" * 100_001
        report = analyze(
            FakeStore(
                sessions=[
                    {
                        "id": "large-prompt",
                        "source": "telegram",
                        "title": "Private title",
                        "system_prompt": prompt,
                        "api_calls": 2,
                    },
                    {
                        "id": "prompt-boundary",
                        "source": "telegram",
                        "system_prompt": "x" * 100_000,
                        "api_calls": 2,
                    },
                ]
            )
        )

        findings = report["findings"]
        self.assertEqual(1, len(findings))
        finding = findings[0]
        self.assertEqual("large_initial_prompt", finding["code"])
        self.assertEqual("large-prompt", finding["session_id"])
        self.assertEqual(100_001, finding["system_prompt_bytes"])
        self.assertEqual(2, finding["api_calls"])
        self.assertEqual(50_002, finding["estimated_repeated_workload_tokens"])
        self.assertEqual(
            "ceil(system_prompt_utf8_bytes / 4) * api_call_count",
            finding["workload_estimate_method"],
        )
        self.assertEqual("measured_exposure", finding["impact"]["kind"])
        self.assertIn("cache", finding["impact"]["caveat"])
        self.assertIn("context", finding["impact"]["caveat"])
        self.assertNotIn("estimated_repeated_workload_bytes", finding)
        serialized = str(report)
        self.assertNotIn(prompt, serialized)
        self.assertNotIn("Private title", serialized)

    def test_large_initial_prompt_reports_at_byte_threshold_even_with_zero_api_calls(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[
                    {
                        "id": "zero-api-calls",
                        "system_prompt": "x" * 100_001,
                        "api_calls": 0,
                    }
                ]
            )
        )

        findings = [
            finding for finding in report["findings"] if finding["code"] == "large_initial_prompt"
        ]
        self.assertEqual(1, len(findings))
        self.assertEqual("zero-api-calls", findings[0]["session_id"])
        self.assertEqual(0, findings[0]["api_calls"])
        self.assertEqual(0, findings[0]["estimated_repeated_workload_tokens"])

    def test_large_initial_prompt_with_lone_surrogate_uses_utf8_replacement_without_content(self):
        from trajectory_analyzer.analyzer import analyze

        malformed_prompt = "x" * 100_000 + "\ud800"
        report = analyze(
            FakeStore(
                sessions=[
                    {
                        "id": "malformed-prompt",
                        "system_prompt": malformed_prompt,
                        "api_calls": 0,
                    }
                ]
            )
        )

        findings = [
            finding for finding in report["findings"] if finding["code"] == "large_initial_prompt"
        ]
        self.assertEqual(1, len(findings))
        self.assertEqual("malformed-prompt", findings[0]["session_id"])
        self.assertEqual(100_001, findings[0]["system_prompt_bytes"])
        self.assertEqual(0, findings[0]["estimated_repeated_workload_tokens"])
        self.assertNotIn(malformed_prompt, str(report))

    def test_low_cache_reuse_reports_observed_ratio_after_workload_and_call_gates(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[
                    {
                        "id": "low-cache",
                        "source": "telegram",
                        "input_tokens": 80_000,
                        "cache_read_tokens": 20_000,
                        "api_calls": 3,
                    },
                    {
                        "id": "below-workload",
                        "input_tokens": 79_999,
                        "cache_read_tokens": 20_000,
                        "api_calls": 3,
                    },
                    {
                        "id": "ratio-boundary",
                        "input_tokens": 50_000,
                        "cache_read_tokens": 50_000,
                        "api_calls": 3,
                    },
                    {
                        "id": "one-call",
                        "input_tokens": 80_000,
                        "cache_read_tokens": 20_000,
                        "api_calls": 1,
                    },
                ]
            )
        )

        findings = [finding for finding in report["findings"] if finding["code"] == "low_cache_reuse"]
        self.assertEqual(1, len(findings))
        finding = findings[0]
        self.assertEqual("low-cache", finding["session_id"])
        self.assertEqual(100_000, finding["relevant_workload_tokens"])
        self.assertEqual(0.20, finding["observed_cache_reuse_ratio"])
        self.assertEqual("measured_exposure", finding["impact"]["kind"])
        self.assertNotIn("TTL", str(finding))

    def test_same_model_child_exposure_requires_benchmark_and_skips_invalid_links(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[
                    {"id": "parent", "model": "gpt-5.6-sol"},
                    {
                        "id": "child", "parent_session_id": "parent", "model": "gpt-5.6-sol",
                        "model_config": json.dumps({"_delegate_from": "parent"}),
                        "api_calls": 10, "input_tokens": 100, "output_tokens": 20,
                        "cache_read_tokens": 30, "cache_write_tokens": 40, "reasoning_tokens": 50,
                    },
                    {
                        "id": "reset-child", "parent_session_id": "parent",
                        "model": "gpt-5.6-sol", "api_calls": 10, "input_tokens": 999,
                    },
                    {"id": "other-parent", "model": "gpt-5.6-sol"},
                    {
                        "id": "other-model", "parent_session_id": "other-parent", "model": "gpt-5.6-mini",
                        "model_config": json.dumps({"_delegate_from": "other-parent"}),
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "under-calls", "parent_session_id": "parent", "model": "gpt-5.6-sol",
                        "model_config": json.dumps({"_delegate_from": "parent"}),
                        "api_calls": 9, "input_tokens": 999,
                    },
                    {
                        "id": "missing-parent", "parent_session_id": "absent", "model": "gpt-5.6-sol",
                        "model_config": json.dumps({"_delegate_from": "absent"}),
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "cycle-a", "parent_session_id": "cycle-b", "model": "gpt-5.6-sol",
                        "model_config": json.dumps({"_delegate_from": "cycle-b"}),
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "cycle-b", "parent_session_id": "cycle-a", "model": "gpt-5.6-sol",
                        "model_config": json.dumps({"_delegate_from": "cycle-a"}),
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {"id": "no-model-parent"},
                    {
                        "id": "no-model", "parent_session_id": "no-model-parent", "api_calls": 10,
                        "model_config": json.dumps({"_delegate_from": "no-model-parent"}),
                        "input_tokens": 999,
                    },
                ]
            )
        )

        findings = [
            finding for finding in report["findings"]
            if finding["code"] == "same_model_subagent_exposure"
        ]
        self.assertEqual(1, len(findings))
        finding = findings[0]
        self.assertEqual("child", finding["session_id"])
        self.assertEqual("parent", finding["parent_session_id"])
        self.assertEqual("gpt-5.6-sol", finding["model"])
        self.assertEqual(240, finding["child_workload_tokens"])
        self.assertEqual("benchmark_required", finding["impact"]["kind"])
        self.assertIn("benchmark", finding["impact"]["caveat"])
        self.assertNotIn("replacement", str(finding).lower())

    def test_nonstandard_json_constants_in_model_config_fail_soft(self):
        from trajectory_analyzer.analyzer import analyze

        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                report = analyze(
                    FakeStore(
                        sessions=[
                            {"id": "parent", "model": "gpt-test"},
                            {
                                "id": "child",
                                "parent_session_id": "parent",
                                "model": "gpt-test",
                                "model_config": (
                                    '{"_delegate_from":"parent","noise":'
                                    f"{constant}}}"
                                ),
                                "api_calls": 10,
                                "input_tokens": 123,
                            },
                        ]
                    )
                )

                self.assertEqual([], report["findings"])

    def test_source_filtered_delegate_uses_parent_model_without_analyzing_parent(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT,
                system_prompt_hash TEXT, api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            INSERT INTO sessions (id, source, started_at, model)
            VALUES ('parent', 'telegram', 1788048000.0, 'gpt-test');
            INSERT INTO sessions (
                id, source, started_at, model, parent_session_id, model_config,
                api_call_count, input_tokens
            ) VALUES (
                'child', 'subagent', 1788048001.0, 'gpt-test', 'parent',
                '{"_delegate_from":"parent"}', 10, 123
            );
            """
        )

        report = analyze(
            SqliteStore(connection),
            source="subagent",
            now=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(1, report["sessions_analyzed"])
        findings = [
            finding for finding in report["findings"]
            if finding["code"] == "same_model_subagent_exposure"
        ]
        self.assertEqual(1, len(findings))
        self.assertEqual("child", findings[0]["session_id"])
        self.assertEqual("parent", findings[0]["parent_session_id"])

    def test_sqlite_store_reads_authoritative_api_call_count_schema(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT,
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            INSERT INTO sessions (
                id, source, started_at, system_prompt, api_call_count
            ) VALUES ('authoritative-schema', 'telegram', 1788048000.0, 'x', 2);
            """
        )

        now = datetime(2026, 8, 30, tzinfo=timezone.utc)
        store = SqliteStore(connection)

        sessions = store.fetch_sessions(days=30, source="telegram", now=now)
        report = analyze(store, source="telegram", now=now)

        self.assertEqual(2, sessions[0]["api_calls"])
        self.assertEqual(1, report["sessions_analyzed"])
        self.assertEqual([], report["findings"])

    def test_sqlite_store_reads_deduplicated_system_prompt_with_one_bounded_join(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT,
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT
            );
            INSERT INTO system_prompts (hash, prompt) VALUES ('prompt-hash', 'x');
            INSERT INTO sessions (
                id, source, started_at, system_prompt, system_prompt_hash, api_call_count
            ) VALUES ('deduplicated-prompt', 'telegram', 1788048000.0, NULL, 'prompt-hash', 0);
            """
        )
        connection.execute(
            "UPDATE system_prompts SET prompt = ? WHERE hash = 'prompt-hash'", ("x" * 100_001,)
        )
        statements = []
        connection.set_trace_callback(statements.append)

        report = analyze(
            SqliteStore(connection), source="telegram", now=datetime(2026, 8, 30, tzinfo=timezone.utc)
        )

        selects = [
            statement for statement in statements if statement.lstrip().upper().startswith("SELECT")
        ]
        findings = [
            finding for finding in report["findings"] if finding["code"] == "large_initial_prompt"
        ]
        self.assertEqual(2, len(selects))
        self.assertIn("LEFT JOIN system_prompts", selects[0])
        self.assertIn("COALESCE(sp.prompt, s.system_prompt) AS system_prompt", selects[0])
        self.assertEqual(1, len(findings))
        self.assertEqual("deduplicated-prompt", findings[0]["session_id"])
        self.assertEqual(0, findings[0]["api_calls"])
        self.assertEqual(0, findings[0]["estimated_repeated_workload_tokens"])
        self.assertNotIn("x" * 100_001, str(report))
