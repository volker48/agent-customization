import pathlib
import sqlite3
import sys
import unittest
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from fakes import FakeStore


class AnalyzerTests(unittest.TestCase):
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
        self.assertEqual(40_001, finding["payload_bytes"])
        self.assertEqual(2, finding["later_assistant_steps"])
        self.assertEqual("estimated_avoidable_workload", finding["impact"]["kind"])
        self.assertEqual(20_002, finding["impact"]["tokens"])
        self.assertEqual(20_002, report["summary"]["estimated_avoidable_tokens"])
        self.assertNotIn("PAYLOAD_SENTINEL", str(report))

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

        self.assertEqual(40_002, report["findings"][0]["payload_bytes"])
        self.assertEqual(20_002, report["findings"][0]["impact"]["tokens"])

    def test_numeric_tool_message_id_is_retained_as_evidence(self):
        from trajectory_analyzer.analyzer import analyze

        report = analyze(
            FakeStore(
                sessions=[{"id": "session-1", "source": "telegram"}],
                messages=[
                    {"session_id": "session-1", "role": "user", "active": 1},
                    {"id": 17, "session_id": "session-1", "role": "tool", "tool_name": "web_extract", "content": "x" * 40_001, "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                    {"session_id": "session-1", "role": "assistant", "active": 1},
                ],
            )
        )

        self.assertEqual(17, report["findings"][0]["tool_message_id"])

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

    def test_sqlite_store_filters_source_and_inactive_rows_in_its_two_queries(self):
        from trajectory_analyzer.analyzer import SqliteStore, analyze

        connection = sqlite3.connect(":memory:")
        connection.executescript(
            """
            CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL);
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT
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
                timestamp REAL NOT NULL, content TEXT, tool_name TEXT
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
        self.assertIn("s.started_at >= ?", message_query)
        self.assertIn("s.source = ?", message_query)
        self.assertEqual(2, len(message_parameters))
