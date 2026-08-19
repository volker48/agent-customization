#!/usr/bin/env python3
"""Run deterministic verification for the Hermes PRO-LONG plugin."""

from __future__ import annotations

import argparse
import importlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_PATH = REPO_ROOT / "hermes-plugins" / "prolong"


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"[prolong-verify] $ {' '.join(command)}", flush=True)
    subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        check=True,
    )


def sanitized_environment() -> dict[str, str]:
    env = dict(os.environ)
    for name in ("HERMES_SOURCE", "PYTHONPATH", "PYTHONHOME"):
        env.pop(name, None)
    return env


def resolve_hermes_paths(source: Path) -> tuple[Path, Path]:
    python = source / "venv" / "bin" / "python"
    hermes = source / "venv" / "bin" / "hermes"
    missing = [path for path in (python, hermes) if not path.is_file()]
    if missing:
        joined = ", ".join(str(path) for path in missing)
        raise FileNotFoundError(f"Hermes runtime executable(s) missing: {joined}")
    return python, hermes


def benchmark(record_count: int) -> None:
    sys.path.insert(0, str(REPO_ROOT))
    support = importlib.import_module("tests.hermes_prolong.test_plugin_registration")
    support.load_plugin_module()
    projection = importlib.import_module("test_hermes_prolong_plugin.projection")
    records = tuple(
        {
            "record_type": "message",
            "lineage_index": 0,
            "session_id": "benchmark",
            "message": {
                "id": index,
                "role": "user" if index % 2 == 0 else "assistant",
                "content": f"payload-{index}",
            },
        }
        for index in range(record_count)
    )
    with tempfile.TemporaryDirectory(prefix="hermes-prolong-benchmark-") as directory:
        path = (
            Path(directory)
            / "plugin-data"
            / "prolong"
            / "sessions"
            / "benchmark"
            / "trajectory.jsonl"
        )
        store = projection.ProjectionStore(path)
        cold = store.sync(records)
        unchanged = store.sync(records)

    print(
        "[prolong-verify] benchmark "
        f"records={record_count} bytes={unchanged.byte_size} "
        f"cold_ms={cold.elapsed_ms:.3f} noop_ms={unchanged.elapsed_ms:.3f}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--hermes-source",
        type=Path,
        default=Path(
            os.environ.get(
                "HERMES_SOURCE",
                Path.home() / ".hermes" / "hermes-agent",
            )
        ),
    )
    parser.add_argument("--benchmark-records", type=int, default=50_000)
    args = parser.parse_args()

    hermes_source = args.hermes_source.expanduser().resolve()
    hermes_python, hermes = resolve_hermes_paths(hermes_source)

    model_free_env = sanitized_environment()
    run(
        [
            sys.executable,
            "-m",
            "unittest",
            "discover",
            "-s",
            "tests/hermes_prolong",
            "-p",
            "test_*.py",
            "-v",
        ],
        env=model_free_env,
    )
    runtime_env = sanitized_environment()
    runtime_env["HERMES_SOURCE"] = str(hermes_source)
    run(
        [
            str(hermes_python),
            "-m",
            "unittest",
            "tests.hermes_prolong.test_runtime_contract",
            "-v",
        ],
        env=runtime_env,
    )
    run(
        [str(hermes), "plugins", "doctor", str(PLUGIN_PATH), "--ci"],
        env=model_free_env,
    )
    benchmark(args.benchmark_records)
    print("[prolong-verify] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
