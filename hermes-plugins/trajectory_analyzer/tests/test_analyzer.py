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
                        "api_calls": 10, "input_tokens": 100, "output_tokens": 20,
                        "cache_read_tokens": 30, "cache_write_tokens": 40, "reasoning_tokens": 50,
                    },
                    {"id": "other-parent", "model": "gpt-5.6-sol"},
                    {
                        "id": "other-model", "parent_session_id": "other-parent", "model": "gpt-5.6-mini",
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "under-calls", "parent_session_id": "parent", "model": "gpt-5.6-sol",
                        "api_calls": 9, "input_tokens": 999,
                    },
                    {
                        "id": "missing-parent", "parent_session_id": "absent", "model": "gpt-5.6-sol",
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "cycle-a", "parent_session_id": "cycle-b", "model": "gpt-5.6-sol",
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {
                        "id": "cycle-b", "parent_session_id": "cycle-a", "model": "gpt-5.6-sol",
                        "api_calls": 10, "input_tokens": 999,
                    },
                    {"id": "no-model-parent"},
                    {
                        "id": "no-model", "parent_session_id": "no-model-parent", "api_calls": 10,
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
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, title TEXT, model TEXT,
                parent_session_id TEXT, system_prompt TEXT, api_calls INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
                reasoning_tokens INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT
            );
            INSERT INTO sessions (id, source, started_at) VALUES ('telegram-session', 'telegram', 1788048000.0);
            INSERT INTO sessions (id, source, started_at) VALUES ('other-session', 'discord', 1788048000.0);
            INSERT INTO messages VALUES
                (1, 'telegram-session', 'user', 1, 1788048001.0, 'private prompt');
            INSERT INTO messages VALUES
                (2, 'telegram-session', 'assistant', 1, 1788048002.0, 'private response');
            INSERT INTO messages VALUES
                (3, 'telegram-session', 'assistant', 0, 1788048003.0, 'inactive response');
            INSERT INTO messages VALUES
                (4, 'other-session', 'user', 1, 1788048004.0, 'other prompt');
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
                parent_session_id TEXT, system_prompt TEXT, api_calls INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
                reasoning_tokens INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, active INTEGER,
                timestamp REAL NOT NULL, content TEXT
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
        self.assertIn("s.started_at >= ?", message_query)
        self.assertIn("s.source = ?", message_query)
        self.assertEqual(2, len(message_parameters))
