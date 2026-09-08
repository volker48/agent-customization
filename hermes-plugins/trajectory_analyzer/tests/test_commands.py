import argparse
import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from fakes import FakeContext, FakeStore


class CommandRegistrationTests(unittest.TestCase):
    def test_registers_exactly_the_trajectory_command(self):
        from trajectory_analyzer import register

        context = FakeContext()
        register(context)

        self.assertEqual(1, len(context.commands))
        command = context.commands[0]
        self.assertEqual("trajectory", command["name"])
        self.assertEqual("Analyze persisted Hermes session trajectories", command["help"])
        self.assertEqual("Local, privacy-safe trajectory analysis", command["description"])
        self.assertTrue(callable(command["setup_fn"]))
        self.assertTrue(callable(command["handler_fn"]))

    def test_analyze_prints_a_private_high_assistant_steps_finding(self):
        from trajectory_analyzer.cli import handle_cli

        store = FakeStore(
            sessions=[{"id": "session-1", "source": "telegram"}],
            messages=[
                {
                    "session_id": "session-1",
                    "role": "user",
                    "active": 1,
                    "content": "private prompt",
                },
                *[
                    {
                        "session_id": "session-1",
                        "role": "assistant",
                        "active": 1,
                        "content": "secret response",
                    }
                    for _ in range(9)
                ],
            ],
        )
        output = io.StringIO()
        with redirect_stdout(output):
            report = handle_cli(
                argparse.Namespace(trajectory_command="analyze", days=30, source=None),
                store=store,
            )

        terminal = output.getvalue()
        self.assertEqual("high_assistant_steps_per_turn", report["findings"][0]["code"])
        self.assertEqual("measured_exposure", report["findings"][0]["impact"]["kind"])
        self.assertIn("high_assistant_steps_per_turn", terminal)
        self.assertIn("assistant_steps=9", terminal)
        self.assertIn("session-1", terminal)
        self.assertIn(
            "Assistant steps are not an exact per-turn or provider-call mapping; "
            "persisted session-level API call counts cannot be attributed to individual turns.",
            terminal,
        )
        self.assertNotIn("private prompt", terminal)
        self.assertNotIn("secret response", terminal)
        self.assertNotIn("private prompt", json.dumps(report))
        self.assertNotIn("secret response", json.dumps(report))

    def test_analyze_recommends_batching_or_execute_code_for_tool_fanout(self):
        from trajectory_analyzer.cli import handle_cli

        calls = [
            {"name": "read_file", "arguments": {"path": f"private-{index}.txt"}}
            for index in range(13)
        ]
        store = FakeStore(
            sessions=[{"id": "session-1", "source": "telegram"}],
            messages=[
                {"session_id": "session-1", "role": "user", "active": 1},
                {"session_id": "session-1", "role": "assistant", "active": 1, "tool_calls": calls},
            ],
        )
        output = io.StringIO()
        with redirect_stdout(output):
            handle_cli(
                argparse.Namespace(trajectory_command="analyze", days=30, source=None),
                store=store,
            )

        terminal = output.getvalue()
        self.assertIn("high_tool_fanout_per_turn", terminal)
        self.assertIn("tool_calls=13", terminal)
        self.assertIn("batching", terminal)
        self.assertIn("execute_code", terminal)
        self.assertNotIn("private-0.txt", terminal)

    def test_analyze_preserves_legitimate_retries_in_repeat_recommendation(self):
        from trajectory_analyzer.cli import handle_cli

        calls = [
            {"name": "read_file", "arguments": {"path": "private.txt", "offset": 1}}
            for _ in range(3)
        ]
        store = FakeStore(
            sessions=[{"id": "session-1", "source": "telegram"}],
            messages=[
                {"session_id": "session-1", "role": "user", "active": 1},
                {"session_id": "session-1", "role": "assistant", "active": 1, "tool_calls": calls},
            ],
        )
        output = io.StringIO()
        with redirect_stdout(output):
            handle_cli(
                argparse.Namespace(trajectory_command="analyze", days=30, source=None),
                store=store,
            )

        terminal = output.getvalue()
        self.assertIn("repeated_exact_tool_call", terminal)
        self.assertIn("caching", terminal)
        self.assertIn("execute_code", terminal)
        self.assertIn("legitimate retries", terminal)
        self.assertNotIn("private.txt", terminal)

    def test_analyze_rejects_an_extreme_positive_day_count(self):
        from trajectory_analyzer.cli import setup_cli

        parser = argparse.ArgumentParser()
        setup_cli(parser)

        with self.assertRaises(SystemExit) as raised:
            parser.parse_args(["analyze", "--days", str(10**100)])

        self.assertEqual(2, raised.exception.code)

    def test_analyze_rejects_non_positive_days(self):
        from trajectory_analyzer.cli import setup_cli

        parser = argparse.ArgumentParser()
        setup_cli(parser)

        for value in ("0", "-1"):
            with self.subTest(value=value):
                try:
                    parser.parse_args(["analyze", "--days", value])
                except SystemExit as raised:
                    self.assertEqual(2, raised.code)
                else:
                    self.fail("Expected argparse to reject a non-positive day count")
