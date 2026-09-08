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
            CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_calls TEXT
            );
            INSERT INTO sessions VALUES ('persisted-session', 'telegram', 1788048000.0);
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
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
            (1, "persisted-session", "user", 1, 1788048001.0, "private prompt", None),
        )
        connection.execute(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
            (2, "persisted-session", "assistant", 1, 1788048002.0, None, json.dumps(calls)),
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
            CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_calls TEXT
            );
            INSERT INTO sessions VALUES ('telegram-session', 'telegram', 1788048000.0);
            INSERT INTO sessions VALUES ('other-session', 'discord', 1788048000.0);
            INSERT INTO messages VALUES
                (1, 'telegram-session', 'user', 1, 1788048001.0, 'private prompt', NULL);
            INSERT INTO messages VALUES
                (2, 'telegram-session', 'assistant', 1, 1788048002.0, 'private response', NULL);
            INSERT INTO messages VALUES
                (3, 'telegram-session', 'assistant', 0, 1788048003.0, 'inactive response', NULL);
            INSERT INTO messages VALUES
                (4, 'other-session', 'user', 1, 1788048004.0, 'other prompt', NULL);
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
            CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_calls TEXT
            );
            """
        )
        connection.executemany(
            "INSERT INTO sessions VALUES (?, 'telegram', 1788048000.0)",
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
