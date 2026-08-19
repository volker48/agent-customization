from __future__ import annotations

import importlib
import unittest
from typing import Any

from tests.hermes_prolong.test_plugin_registration import PLUGIN_DIR, load_plugin_module


class FakeSessionDB:
    def __init__(self) -> None:
        self.closed = False
        self._conn: Any | None = None
        self.sessions: dict[str, dict[str, Any]] = {
            "root": {
                "id": "root",
                "parent_session_id": None,
                "source": "cli",
                "started_at": 1.0,
                "ended_at": 2.0,
                "end_reason": "compression",
                "compression_count": 1,
                "rewind_count": 0,
                "system_prompt": "must not be duplicated",
            },
            "tip": {
                "id": "tip",
                "parent_session_id": "root",
                "source": "cli",
                "started_at": 3.0,
                "ended_at": None,
                "end_reason": None,
                "compression_count": 0,
                "rewind_count": 1,
            },
        }
        self.messages: dict[str, list[dict[str, Any]]] = {
            "root": [
                {
                    "id": 10,
                    "session_id": "root",
                    "role": "user",
                    "content": "earlier nonce",
                    "active": 0,
                    "compacted": 1,
                },
                {
                    "id": 11,
                    "session_id": "root",
                    "role": "assistant",
                    "content": "old answer",
                    "active": 0,
                    "compacted": 1,
                },
            ],
            "tip": [
                {
                    "id": 20,
                    "session_id": "tip",
                    "role": "user",
                    "content": "rewound branch",
                    "active": 0,
                    "compacted": 0,
                },
                {
                    "id": 21,
                    "session_id": "tip",
                    "role": "user",
                    "content": "current question",
                    "active": 1,
                    "compacted": 0,
                },
            ],
        }

    def get_compression_lineage(self, session_id: str):
        if session_id != "tip":
            raise AssertionError(f"unexpected session id: {session_id}")
        return ["root", "tip"]

    def get_session(self, session_id: str):
        return self.sessions[session_id]

    def get_messages(self, session_id: str, *, include_inactive: bool):
        if include_inactive is not True:
            raise AssertionError("reader must inspect compacted rows")
        return self.messages[session_id]

    def close(self) -> None:
        self.closed = True


class IncrementalFakeSessionDB(FakeSessionDB):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[dict] = []
        self.sessions = {"tip": self.sessions["tip"]}
        self.messages = {
            "tip": [
                {
                    "id": 21,
                    "session_id": "tip",
                    "role": "user",
                    "content": "current question",
                    "active": 1,
                    "compacted": 0,
                }
            ]
        }

    def get_compression_lineage(self, session_id: str):
        return [session_id]

    def get_messages(self, session_id: str, *, include_inactive: bool, **kwargs):
        self.calls.append(dict(kwargs))
        messages = list(self.messages[session_id])
        after_id = kwargs.get("after_id")
        if after_id is not None:
            messages = [message for message in messages if message["id"] > after_id]
        return messages


class FakeDataVersionConnection:
    def __init__(self, version: int) -> None:
        self.version = version
        self.in_transaction = False

    def execute(self, statement: str):
        if statement == "BEGIN":
            self.in_transaction = True
        return self

    def fetchone(self) -> tuple[int]:
        return (self.version,)

    def rollback(self) -> None:
        self.in_transaction = False


class HermesSessionReaderTests(unittest.TestCase):
    def test_unknown_persisted_message_fields_fail_loudly(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        database = FakeSessionDB()
        database.messages["tip"][1]["future_persisted_field"] = "must-not-drop"
        reader = module.HermesSessionReader(db_factory=lambda: database)

        with self.assertRaisesRegex(
            RuntimeError, "unsupported persisted message fields"
        ):
            reader.snapshot("tip")

    def test_matching_data_version_returns_the_previous_snapshot_unchanged(
        self,
    ) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        database = IncrementalFakeSessionDB()
        database._conn = FakeDataVersionConnection(19)
        reader = module.HermesSessionReader(db_factory=lambda: database)

        first = reader.snapshot("tip")
        calls_after_first = len(database.calls)
        second = reader.snapshot("tip", previous=first)

        self.assertIs(second, first)
        self.assertEqual(first.source_version, 19)
        self.assertEqual(len(database.calls), calls_after_first)

    def test_projects_only_the_complete_active_compression_lineage(self) -> None:
        module_path = PLUGIN_DIR / "session_reader.py"
        self.assertTrue(
            module_path.is_file(), f"session reader is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        database = FakeSessionDB()
        reader = module.HermesSessionReader(db_factory=lambda: database)

        snapshot = reader.snapshot("tip")

        self.assertEqual(snapshot.lineage, ("root", "tip"))
        self.assertEqual(snapshot.message_count, 3)
        self.assertEqual(snapshot.max_message_id, 21)
        self.assertEqual(
            [record["record_type"] for record in snapshot.records],
            ["session_segment", "message", "message", "session_segment", "message"],
        )
        self.assertEqual(
            [
                record["message"]["content"]
                for record in snapshot.records
                if record["record_type"] == "message"
            ],
            ["earlier nonce", "old answer", "current question"],
        )
        first_segment = snapshot.records[0]
        self.assertEqual(first_segment["session"]["end_reason"], "compression")
        self.assertNotIn("system_prompt", first_segment["session"])
        self.assertEqual(snapshot.records[-1]["lineage_index"], 1)

        reader.close()
        self.assertTrue(database.closed)

    def test_long_message_content_has_bounded_overlapping_search_chunks(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        database = FakeSessionDB()
        nonce = "PLG_NONCE_chunk_boundary_regression"
        long_content = ("A" * 695) + " MARKER=" + nonce + " " + ("B" * 1_000)
        database.messages["root"][0]["content"] = long_content
        reader = module.HermesSessionReader(db_factory=lambda: database)

        snapshot = reader.snapshot("tip")

        raw_messages = [
            record
            for record in snapshot.records
            if record["record_type"] == "message" and record["message"].get("id") == 10
        ]
        chunks = [
            record
            for record in snapshot.records
            if record["record_type"] == "message_content_chunk"
            and record["message_id"] == 10
        ]
        self.assertEqual(raw_messages[0]["message"]["content"], long_content)
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(len(record["content"]) <= 700 for record in chunks))
        self.assertTrue(any(nonce in record["content"] for record in chunks))
        self.assertEqual(
            [record["chunk_index"] for record in chunks], list(range(len(chunks)))
        )
        self.assertTrue(all(record["chunk_count"] == len(chunks) for record in chunks))

    def test_reuses_unchanged_snapshot_and_fetches_only_the_new_tail(self) -> None:
        module_path = PLUGIN_DIR / "session_reader.py"
        self.assertTrue(
            module_path.is_file(), f"session reader is missing: {module_path}"
        )
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        database = IncrementalFakeSessionDB()
        reader = module.HermesSessionReader(db_factory=lambda: database)

        first = reader.snapshot("tip")
        unchanged = reader.snapshot("tip", previous=first)

        self.assertIs(unchanged, first)
        self.assertEqual(database.calls[-1]["after_id"], 20)

        database.messages["tip"].append(
            {
                "id": 22,
                "session_id": "tip",
                "role": "assistant",
                "content": "new suffix",
                "active": 1,
                "compacted": 0,
            }
        )
        extended = reader.snapshot("tip", previous=unchanged)

        self.assertIsNot(extended, first)
        self.assertEqual(extended.message_count, 2)
        self.assertEqual(extended.max_message_id, 22)
        self.assertEqual(extended.records[: len(first.records)], first.records)
        self.assertEqual(extended.records[-1]["message"]["content"], "new suffix")
        self.assertEqual(database.calls[-1]["after_id"], 20)

    def test_every_incremental_full_fallback_preserves_source_version(self) -> None:
        load_plugin_module()
        module = importlib.import_module("test_hermes_prolong_plugin.session_reader")
        source_version = 73

        def reader_and_previous(
            database: IncrementalFakeSessionDB,
            lineage: tuple[str, ...] = ("tip",),
        ) -> tuple[Any, Any]:
            reader = module.HermesSessionReader(db_factory=lambda: database)
            previous = reader._full_snapshot(
                database,
                lineage,
                source_version=source_version,
            )
            return reader, previous

        cases: list[
            tuple[str, Any, IncrementalFakeSessionDB, tuple[str, ...], Any]
        ] = []

        database = IncrementalFakeSessionDB()
        reader, previous = reader_and_previous(database)
        database.sessions["tip"]["rewind_count"] += 1
        cases.append(("segment marker changed", reader, database, ("tip",), previous))

        database = IncrementalFakeSessionDB()
        database.messages["tip"] = []
        reader, previous = reader_and_previous(database)
        database.messages["tip"].append(
            {
                "id": 22,
                "session_id": "tip",
                "role": "user",
                "content": "first message",
                "active": 1,
                "compacted": 0,
            }
        )
        cases.append(
            ("previously empty segment grew", reader, database, ("tip",), previous)
        )

        database = IncrementalFakeSessionDB()
        reader, previous = reader_and_previous(database)
        database.messages["tip"][0]["id"] = 22
        cases.append(("prior tail disappeared", reader, database, ("tip",), previous))

        database = IncrementalFakeSessionDB()
        reader, previous = reader_and_previous(database)
        database.messages["tip"][0]["content"] = "edited in place"
        cases.append(("prior tail changed", reader, database, ("tip",), previous))

        database = IncrementalFakeSessionDB()
        database.sessions["root"] = {
            **database.sessions["tip"],
            "id": "root",
            "parent_session_id": None,
        }
        database.messages["root"] = [
            {
                **database.messages["tip"][0],
                "id": 10,
                "session_id": "root",
            }
        ]
        lineage = ("root", "tip")
        reader, previous = reader_and_previous(database, lineage)
        database.messages["root"].append(
            {
                "id": 11,
                "session_id": "root",
                "role": "assistant",
                "content": "late ancestor suffix",
                "active": 1,
                "compacted": 0,
            }
        )
        cases.append(("ancestor segment grew", reader, database, lineage, previous))

        for label, reader, database, case_lineage, previous in cases:
            with self.subTest(label):
                refreshed = reader._incremental_snapshot(
                    database, case_lineage, previous
                )
                self.assertEqual(refreshed.source_version, source_version)
                self.assertIsNot(refreshed, previous)


if __name__ == "__main__":
    unittest.main()
