#!/usr/bin/env python3
"""Real-model, native-/compress verification for Hermes PRO-LONG."""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping

if TYPE_CHECKING:
    import pexpect


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_PATH = REPO_ROOT / "hermes-plugins" / "prolong"
DEFAULT_HERMES_SOURCE = Path.home() / ".hermes" / "hermes-agent"
SEED_LINE_WIDTH = 100
SEED_LEADING_LINE_COUNT = 43
SEED_TRAILING_LINE_COUNT = 22


def build_seed_source(nonce: str) -> str:
    """Keep the nonce outside Hermes's summary head/tail without long lines."""
    lines = (
        (["A" * SEED_LINE_WIDTH] * SEED_LEADING_LINE_COUNT)
        + [f"MARKER={nonce}"]
        + (["B" * SEED_LINE_WIDTH] * SEED_TRAILING_LINE_COUNT)
    )
    return "\n".join(lines) + "\n"


def copy_credentials(source_home: Path, destination_home: Path) -> None:
    source = source_home / "auth.json"
    if not source.is_file():
        raise RuntimeError(f"OpenAI Codex auth.json was not found under {source_home}")
    source_metadata = source.lstat()
    if (
        not stat.S_ISREG(source_metadata.st_mode)
        or source_metadata.st_uid != os.getuid()
        or stat.S_IMODE(source_metadata.st_mode) != 0o600
    ):
        raise RuntimeError(f"Refusing unsafe Hermes credential source: {source}")
    raw = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise RuntimeError("Hermes auth.json was not a JSON object")

    filtered: dict[str, Any] = {}
    for key in ("version", "updated_at"):
        if key in raw:
            filtered[key] = raw[key]
    active_provider = raw.get("active_provider")
    filtered["active_provider"] = (
        "openai-codex" if active_provider == "openai-codex" else None
    )
    found = False
    for key in ("credential_pool", "providers"):
        section = raw.get(key)
        if isinstance(section, dict) and "openai-codex" in section:
            filtered[key] = {"openai-codex": section["openai-codex"]}
            found = True
    if not found:
        raise RuntimeError("No OpenAI Codex credentials were present in auth.json")
    write_secure_json(destination_home / "auth.json", filtered)


def write_config(home: Path) -> None:
    config = """model:
  provider: openai-codex
  default: gpt-5.6-sol

auxiliary:
  compression:
    provider: openai-codex
    model: gpt-5.6-sol

plugins:
  enabled:
    - prolong
  disabled: []

compression:
  enabled: false
  in_place: true
  protect_first_n: 0
  protect_last_n: 3
  target_ratio: 0.10
  threshold_tokens: 2048
  abort_on_summary_failure: true
  codex_responses_native: false
"""
    path = home / "config.yaml"
    path.write_text(config, encoding="utf-8")
    path.chmod(0o600)


def run_checked(
    command: list[str], env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )


def source_revision(hermes_source: Path, env: dict[str, str]) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(hermes_source), "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            env=env,
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError:
        return "unknown"
    revision = result.stdout.strip()
    return revision if result.returncode == 0 and revision else "unknown"


def write_secure_json(path: Path, value: Mapping[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    parent_metadata = path.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode):
        raise RuntimeError(f"Unsafe evidence directory: {path.parent}")
    if hasattr(os, "getuid") and parent_metadata.st_uid != os.getuid():
        raise RuntimeError(
            f"Evidence directory is not owned by this user: {path.parent}"
        )
    temporary = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | os.O_NOFOLLOW
    )
    descriptor = os.open(temporary, flags, 0o600)
    try:
        payload = (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short evidence write")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.link(temporary, path, follow_symlinks=False)
        directory_descriptor = os.open(
            path.parent,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def path_lexists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def remove_tree_verified(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Refusing unsafe isolated-home cleanup target: {path}")
    shutil.rmtree(path)
    if path_lexists(path):
        raise RuntimeError(f"Credential-bearing isolated root still exists: {path}")


def row_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def projected_seed_messages(
    records: list[dict[str, Any]],
    seed_message_id: int,
    nonce: str,
) -> list[dict[str, Any]]:
    return [
        record["message"]
        for record in records
        if record.get("record_type") == "message"
        and int(record["message"].get("id") or -1) == seed_message_id
        and record["message"].get("role") == "tool"
        and nonce in row_text(record["message"].get("content"))
    ]


def parse_json(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def message_rows(database_path: Path, session_id: str) -> list[dict[str, Any]]:
    with sqlite3.connect(database_path, timeout=30) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def max_message_id(database_path: Path, session_id: str) -> int:
    rows = message_rows(database_path, session_id)
    return max((int(row["id"]) for row in rows), default=0)


def drain(child: pexpect.spawn, output: deque[str]) -> None:
    while True:
        try:
            output.append(child.read_nonblocking(size=8192, timeout=0))
        except (pexpect.TIMEOUT, pexpect.EOF):
            return


def start_compression_capture(
    child: pexpect.spawn,
    output: deque[str],
) -> None:
    output.clear()
    child.sendline("/compress")


def spawn_hermes(
    hermes: Path,
    repo_root: Path,
    env: dict[str, str],
    evidence: dict[str, Any],
) -> pexpect.spawn:
    try:
        return pexpect.spawn(
            str(hermes),
            [
                "chat",
                "--cli",
                "--provider",
                "openai-codex",
                "--model",
                "gpt-5.6-sol",
                "--reasoning",
                "none",
                "--toolsets",
                "file",
                "--ignore-rules",
                "--in",
                str(repo_root),
            ],
            env=env,
            encoding="utf-8",
            codec_errors="replace",
            timeout=120,
            dimensions=(40, 120),
        )
    except Exception as exc:
        evidence["status"] = "failed"
        evidence["error_type"] = type(exc).__name__
        evidence["error"] = str(exc)
        raise


def wait_for(
    child: pexpect.spawn,
    output: deque[str],
    predicate: Callable[[], Any],
    *,
    timeout: float,
    label: str,
) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        drain(child, output)
        if not child.isalive():
            raise RuntimeError(f"Hermes exited while waiting for {label}")
        try:
            result = predicate()
        except (OSError, sqlite3.Error, json.JSONDecodeError) as error:
            last_error = error
            result = None
        if result:
            return result
        time.sleep(0.25)
    suffix = f": {last_error}" if last_error else ""
    raise TimeoutError(f"Timed out waiting for {label}{suffix}")


def wait_for_assistant(
    child: pexpect.spawn,
    output: deque[str],
    database_path: Path,
    session_id: str,
    after_id: int,
    expected: str,
) -> dict[str, Any]:
    def find() -> dict[str, Any] | None:
        for row in message_rows(database_path, session_id):
            if int(row["id"]) <= after_id or row.get("role") != "assistant":
                continue
            if row_text(row.get("content")).strip() == expected:
                return row
        return None

    expected_hash = hashlib.sha256(expected.encode()).hexdigest()[:16]
    return wait_for(
        child,
        output,
        find,
        timeout=300,
        label=f"assistant response sha256={expected_hash}",
    )


def locate_projection(home: Path, session_id: str) -> Path | None:
    candidates = sorted(
        (home / "plugin-data").glob(f"*/sessions/{session_id}/trajectory.jsonl")
    )
    if len(candidates) > 1:
        rendered = ", ".join(str(candidate) for candidate in candidates)
        raise RuntimeError(f"Ambiguous trajectory projection: {rendered}")
    return candidates[0] if candidates else None


def read_projection(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def extract_tool_calls(row: dict[str, Any]) -> list[dict[str, Any]]:
    calls = parse_json(row.get("tool_calls"), [])
    return calls if isinstance(calls, list) else []


def call_name(call: dict[str, Any]) -> str:
    function = call.get("function")
    if isinstance(function, dict):
        return str(function.get("name") or "")
    return str(call.get("name") or "")


def call_arguments(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function")
    raw = (
        function.get("arguments")
        if isinstance(function, dict)
        else call.get("arguments")
    )
    if isinstance(raw, dict):
        return raw
    parsed = parse_json(raw, {})
    return parsed if isinstance(parsed, dict) else {}


def require_plugin_entry(value: Any) -> dict[str, Any]:
    if not isinstance(value, list):
        raise AssertionError("Plugin listing was not a JSON array")
    matches = [
        entry
        for entry in value
        if isinstance(entry, dict) and entry.get("name") == "prolong"
    ]
    if len(matches) != 1:
        raise AssertionError("Plugin listing did not contain exactly one prolong entry")
    entry = matches[0]
    if entry.get("status") != "enabled" or entry.get("source") != "user":
        raise AssertionError("PRO-LONG was not an enabled user plugin")
    return entry


def exact_tool_path(call: dict[str, Any], projection: Path) -> Path:
    raw_path = call_arguments(call).get("path")
    if not isinstance(raw_path, str) or raw_path != str(projection):
        raise AssertionError("Recovery tool did not use the exact advertised path")
    return Path(raw_path)


def is_successful_tool_result(
    row: dict[str, Any],
    *,
    tool_name: str,
    nonce: str,
    call_id: str,
    call_message_id: int,
    final_message_id: int,
) -> bool:
    if not call_id or str(row.get("tool_call_id") or "") != call_id:
        return False
    row_id = int(row.get("id") or -1)
    if not call_message_id < row_id < final_message_id:
        return False
    if row.get("role") != "tool" or not row.get("active") or row.get("compacted"):
        return False
    content = row.get("content")
    parsed = parse_json(content, content)
    failure_statuses = {
        "blocked",
        "cancelled",
        "canceled",
        "denied",
        "error",
        "failed",
        "aborted",
        "timeout",
    }
    if isinstance(parsed, dict):
        if "success" in parsed and parsed.get("success") is not True:
            return False
        payload = parsed.get("data") if "success" in parsed else parsed
        if not isinstance(payload, dict):
            return False
        for candidate in (parsed, payload):
            if candidate.get("error") not in (None, "") or candidate.get("ok") is False:
                return False
            if str(candidate.get("status") or "").lower() in failure_statuses:
                return False
        if tool_name == "search_files":
            evidence = payload.get("matches_text", payload.get("matches"))
            total_count = payload.get("total_count")
            return (
                isinstance(total_count, int)
                and total_count > 0
                and nonce in row_text(evidence)
            )
        if tool_name == "read_file":
            evidence = payload.get("content")
            return (
                isinstance(evidence, str)
                and isinstance(payload.get("total_lines"), int)
                and payload["total_lines"] > 0
                and nonce in evidence
            )
        return False
    if tool_name != "read_file" or not isinstance(content, str):
        return False
    lowered = content.casefold()
    if any(status in lowered for status in failure_statuses):
        return False
    return any(
        re.match(r"^\d+\|", line) and nonce in line for line in content.splitlines()
    )


def verify_permissions(path: Path) -> None:
    if stat.S_IMODE(path.stat().st_mode) != 0o400:
        raise AssertionError(f"Projection mode is not 0400: {path}")
    for directory in (path.parent, path.parent.parent, path.parent.parent.parent):
        if stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise AssertionError(f"Projection directory mode is not 0700: {directory}")


def main() -> int:
    global pexpect
    try:
        import pexpect
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "The opt-in real-session verifier requires Python pexpect"
        ) from error

    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-source", type=Path, default=DEFAULT_HERMES_SOURCE)
    parser.add_argument("--credential-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument(
        "--keep-home",
        action="store_true",
        help="retain the isolated home, including copied credentials, for debugging",
    )
    args = parser.parse_args()

    hermes_source = args.hermes_source.expanduser().resolve()
    hermes = hermes_source / "venv" / "bin" / "hermes"
    if not hermes.is_file():
        raise FileNotFoundError(f"Hermes executable not found: {hermes}")

    evidence_path = args.evidence or (
        Path.home()
        / ".hermes"
        / "cache"
        / (
            "prolong-e2e-"
            f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
            f"{os.getpid()}.json"
        )
    )
    root = Path(tempfile.mkdtemp(prefix="hermes-prolong-e2e-"))
    evidence: dict[str, Any] = {
        "status": "initializing",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "hermes_source": str(hermes_source),
        "isolated_root": str(root),
    }
    finalized = {"done": False}

    def emergency_finalize() -> None:
        if finalized["done"]:
            return
        evidence["status"] = "failed"
        evidence.setdefault(
            "error",
            "Verifier exited before normal finalization completed",
        )
        if args.keep_home:
            evidence["isolated_home_cleanup"] = "retained-by-request"
        else:
            try:
                remove_tree_verified(root)
                evidence["isolated_home_cleanup"] = "removed"
            except Exception as error:
                evidence["isolated_home_cleanup"] = "failed"
                evidence["cleanup_error"] = str(error)
        evidence["completed_at_utc"] = datetime.now(timezone.utc).isoformat()
        try:
            write_secure_json(evidence_path, evidence)
            print(f"[prolong-e2e] failure evidence: {evidence_path}", file=sys.stderr)
        except Exception as error:
            print(
                f"[prolong-e2e] could not write failure evidence: {error}",
                file=sys.stderr,
            )

    atexit.register(emergency_finalize)
    home = root / "home"
    plugins = home / "plugins"
    plugins.mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    home.chmod(0o700)
    copy_credentials(args.credential_home.expanduser(), home)
    write_config(home)
    (plugins / "prolong").symlink_to(PLUGIN_PATH, target_is_directory=True)

    allowed_environment = {
        "PATH",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    }
    env = {
        key: value for key, value in os.environ.items() if key in allowed_environment
    }
    env.update(
        {
            "HOME": str(home),
            "HERMES_HOME": str(home),
            "NO_COLOR": "1",
            "PROMPT_TOOLKIT_NO_CPR": "1",
            "TERM": "dumb",
        }
    )
    doctor = run_checked(
        [str(hermes), "plugins", "doctor", str(PLUGIN_PATH), "--ci"],
        env,
    )
    listing = run_checked(
        [str(hermes), "plugins", "list", "--enabled", "--user", "--json"],
        env,
    )
    listing_data = json.loads(listing.stdout)
    plugin_entry = require_plugin_entry(listing_data)
    hermes_version = run_checked([str(hermes), "--version"], env).stdout.strip()
    hermes_revision = source_revision(hermes_source, env)

    nonce = "PLG_NONCE_" + secrets.token_hex(24)
    seed_source = root / "nonce-source.txt"
    seed_source.write_text(build_seed_source(nonce), encoding="utf-8")
    seed_source.chmod(0o600)
    seed = (
        f"Use read_file on the exact file {seed_source}. "
        "Do not repeat or paraphrase any marker from its result. After the tool "
        "returns, reply exactly ACK-SEED with no commentary and no further tools."
    )
    fillers = [
        "Tool-free filler 1. Do not discuss earlier content. Reply exactly FILLER-1.",
        "Tool-free filler 2. Do not discuss earlier content. Reply exactly FILLER-2.",
        "Tool-free filler 3. Do not discuss earlier content. Reply exactly FILLER-3.",
    ]
    recovery = (
        "Recover the earlier opaque PLG_NONCE marker. You MUST inspect the exact "
        "absolute trajectory.jsonl path given in the PRO-LONG system-prompt section "
        "using only ordinary search_files and/or read_file. Do not use session_search, "
        "memory, terminal, write_file, or patch. Search for the generic text MARKER=. "
        "Return exactly RECOVERED=<marker>, with no commentary."
    )
    if nonce in recovery:
        raise AssertionError("Recovery prompt leaked the nonce")

    output: deque[str] = deque(maxlen=64)
    child = spawn_hermes(hermes, REPO_ROOT, env, evidence)

    evidence.update(
        {
            "status": "running",
            "doctor": doctor.stdout.strip(),
            "hermes_version": hermes_version,
            "hermes_revision": hermes_revision,
            "plugin_identity": plugin_entry,
            "provider": "openai-codex",
            "model": "gpt-5.6-sol",
            "nonce_sha256": hashlib.sha256(nonce.encode()).hexdigest(),
        }
    )
    success = False
    projection_for_cleanup: Path | None = None
    try:
        child.expect(re.compile(r"Session:\s+([A-Za-z0-9_.-]+)"), timeout=120)
        matched_session = child.match
        if not isinstance(matched_session, re.Match):
            raise RuntimeError("Hermes banner did not expose a parseable session ID")
        session_id = matched_session.group(1)
        output.append(str(child.before or "") + str(child.after or ""))
        database_path = home / "state.db"
        wait_for(
            child,
            output,
            lambda: database_path.is_file(),
            timeout=60,
            label="Hermes state database",
        )

        baseline = max_message_id(database_path, session_id)
        child.sendline(seed)
        seed_assistant = wait_for_assistant(
            child,
            output,
            database_path,
            session_id,
            baseline,
            "ACK-SEED",
        )
        seed_phase_rows = [
            row
            for row in message_rows(database_path, session_id)
            if int(row["id"]) > baseline
        ]
        seed_calls = [
            (row, call)
            for row in seed_phase_rows
            if row.get("role") == "assistant"
            for call in extract_tool_calls(row)
        ]
        if len(seed_calls) != 1 or call_name(seed_calls[0][1]) != "read_file":
            raise AssertionError(
                "Seed assistant did not issue exactly one read_file call"
            )
        seed_call_row, seed_call = seed_calls[0]
        exact_tool_path(seed_call, seed_source)
        seed_call_id = str(seed_call.get("id") or "")
        if not seed_call_id:
            raise AssertionError("Seed read_file call had an empty ID")
        if (
            sum(str(call.get("id") or "") == seed_call_id for _, call in seed_calls)
            != 1
        ):
            raise AssertionError("Seed read_file call ID was not unique")
        seed_tool_results = [
            row
            for row in seed_phase_rows
            if row.get("role") == "tool"
            and str(row.get("tool_call_id") or "") == seed_call_id
        ]
        if len(seed_tool_results) != 1 or not is_successful_tool_result(
            seed_tool_results[0],
            tool_name=call_name(seed_call),
            nonce=nonce,
            call_id=seed_call_id,
            call_message_id=int(seed_call_row["id"]),
            final_message_id=int(seed_assistant["id"]),
        ):
            raise AssertionError(
                "Nonce source was not preserved in one ordered successful seed result"
            )
        nonce_rows = [row for row in seed_phase_rows if nonce in row_text(row)]
        if [int(row["id"]) for row in nonce_rows] != [int(seed_tool_results[0]["id"])]:
            raise AssertionError("Nonce provenance was not unique to the seed result")
        if nonce in row_text(seed_assistant):
            raise AssertionError("Seed assistant repeated the nonce")
        seed_source.unlink()
        if path_lexists(seed_source):
            raise AssertionError("Nonce source file was not deleted before compression")

        for index, filler in enumerate(fillers, start=1):
            baseline = max_message_id(database_path, session_id)
            child.sendline(filler)
            response = wait_for_assistant(
                child,
                output,
                database_path,
                session_id,
                baseline,
                f"FILLER-{index}",
            )
            if extract_tool_calls(response):
                raise AssertionError(f"Filler {index} assistant called a tool")

        projection = wait_for(
            child,
            output,
            lambda: locate_projection(home, session_id),
            timeout=60,
            label="initial trajectory projection",
        )
        projection_for_cleanup = projection
        verify_permissions(projection)

        start_compression_capture(child, output)

        def compression_committed() -> list[dict[str, Any]] | None:
            rows = message_rows(database_path, session_id)
            archived = [
                row for row in rows if not row.get("active") and row.get("compacted")
            ]
            active = [row for row in rows if row.get("active")]
            nonce_archived = any(
                nonce in row_text(row.get("content")) for row in archived
            )
            has_handoff = any(
                "[CONTEXT COMPACTION — REFERENCE ONLY]" in row_text(row.get("content"))
                for row in active
            )
            return (
                rows if archived and active and nonce_archived and has_handoff else None
            )

        compressed_rows = wait_for(
            child,
            output,
            compression_committed,
            timeout=600,
            label="native in-place compression commit",
        )
        time.sleep(2)
        drain(child, output)
        compression_output = "".join(output)
        feedback_casefold = compression_output.casefold()
        forbidden_feedback = (
            "compression failed",
            "no changes from compression",
            "fallback",
        )
        if any(text in feedback_casefold for text in forbidden_feedback):
            raise AssertionError("CLI reported failed, no-op, or fallback compression")

        active_after_compress = [row for row in compressed_rows if row.get("active")]
        archived_after_compress = [
            row
            for row in compressed_rows
            if not row.get("active") and row.get("compacted")
        ]
        if any(nonce in row_text(row) for row in active_after_compress):
            raise AssertionError("Nonce survived in active post-compression context")
        seed_rows = [
            row
            for row in archived_after_compress
            if int(row["id"]) == int(seed_tool_results[0]["id"])
            and nonce in row_text(row)
        ]
        if len(seed_rows) != 1:
            raise AssertionError("Expected exactly one archived nonce-bearing seed row")

        recovery_baseline = max_message_id(database_path, session_id)
        child.sendline(recovery)
        final = wait_for_assistant(
            child,
            output,
            database_path,
            session_id,
            recovery_baseline,
            f"RECOVERED={nonce}",
        )

        def projection_caught_up() -> list[dict[str, Any]] | None:
            records = read_projection(projection)
            messages = [
                record["message"]
                for record in records
                if record.get("record_type") == "message"
            ]
            return (
                records
                if any(
                    row_text(message.get("content")).strip() == f"RECOVERED={nonce}"
                    for message in messages
                )
                else None
            )

        projected_records = wait_for(
            child,
            output,
            projection_caught_up,
            timeout=60,
            label="post-recovery projection reconciliation",
        )
        verify_permissions(projection)
        seed_message_id = int(seed_rows[0]["id"])
        projected_seed = projected_seed_messages(
            projected_records,
            seed_message_id,
            nonce,
        )
        if len(projected_seed) != 1:
            raise AssertionError(
                "Projection did not preserve exactly one nonce tool result"
            )
        if not projected_seed[0].get("compacted") or projected_seed[0].get("active"):
            raise AssertionError("Projected nonce seed lacks compacted archival state")

        final_rows = message_rows(database_path, session_id)
        recovery_users = [
            row
            for row in final_rows
            if int(row["id"]) > recovery_baseline and row.get("role") == "user"
        ]
        if len(recovery_users) != 1 or nonce in row_text(
            recovery_users[0].get("content")
        ):
            raise AssertionError("Recovery user row was missing or leaked the nonce")
        recovery_user_id = int(recovery_users[0]["id"])

        calls: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for row in final_rows:
            if int(row["id"]) <= recovery_user_id or row.get("role") != "assistant":
                continue
            for call in extract_tool_calls(row):
                calls.append((row, call))
        if not calls:
            raise AssertionError("Recovery assistant did not call a file tool")
        if any(
            call_name(call) not in {"search_files", "read_file"} for _, call in calls
        ):
            raise AssertionError("Recovery assistant called a non-read/search tool")
        recovery_call_ids = [str(call.get("id") or "") for _, call in calls]
        if any(not call_id for call_id in recovery_call_ids):
            raise AssertionError("Recovery tool call had an empty ID")
        if len(set(recovery_call_ids)) != len(recovery_call_ids):
            raise AssertionError("Recovery tool call IDs were not unique")
        prior_call_ids = {
            str(call.get("id") or "")
            for row in final_rows
            if int(row["id"]) <= recovery_user_id
            for call in extract_tool_calls(row)
            if call.get("id")
        }
        if prior_call_ids.intersection(recovery_call_ids):
            raise AssertionError("Recovery tool call ID collided with prior history")
        for _, recovery_call in calls:
            exact_tool_path(recovery_call, projection)

        if any(
            nonce in json.dumps(call_arguments(call), ensure_ascii=False)
            for _, call in calls
        ):
            raise AssertionError("Recovery tool arguments leaked the nonce")

        evidence_calls: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
        all_tool_results: list[dict[str, Any]] = []
        final_message_id = int(final["id"])
        for call_row, call in calls:
            candidate_call_id = str(call["id"])
            candidate_results = [
                row
                for row in final_rows
                if row.get("role") == "tool"
                and str(row.get("tool_call_id") or "") == candidate_call_id
                and int(call_row["id"]) < int(row["id"]) < final_message_id
            ]
            if len(candidate_results) != 1:
                raise AssertionError(
                    "Recovery tool call did not have exactly one ordered result"
                )
            result = candidate_results[0]
            all_tool_results.append(result)
            if is_successful_tool_result(
                result,
                tool_name=call_name(call),
                nonce=nonce,
                call_id=candidate_call_id,
                call_message_id=int(call_row["id"]),
                final_message_id=final_message_id,
            ):
                evidence_calls.append((call_row, call, result))
        if not evidence_calls:
            raise AssertionError(
                "No successful ordered nonce-bearing recovery result was found"
            )
        call_row, call, tool_result = evidence_calls[0]
        call_id = str(call["id"])
        if extract_tool_calls(final):
            raise AssertionError("Final recovery answer also requested a tool")
        later_assistants = [
            row
            for row in final_rows
            if row.get("role") == "assistant" and int(row["id"]) > final_message_id
        ]
        if later_assistants:
            raise AssertionError("Final recovery answer was not the last assistant row")
        if final_message_id <= max(int(row["id"]) for row in all_tool_results):
            raise AssertionError(
                "Final recovery answer preceded recovery tool evidence"
            )

        call_arguments_json = json.dumps(
            call_arguments(call),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        tool_result_text = row_text(tool_result.get("content"))
        evidence.update(
            {
                "status": "verified-before-shutdown",
                "session_id": session_id,
                "nonce": nonce,
                "seed_message_id": seed_message_id,
                "seed_tool_call_id": seed_call_id,
                "seed_tool_result_message_id": int(seed_tool_results[0]["id"]),
                "seed_active_before_compression": True,
                "seed_compacted": True,
                "active_summary_omitted_nonce": True,
                "compression_feedback_sha256": hashlib.sha256(
                    compression_output.encode()
                ).hexdigest(),
                "projection_path": str(projection),
                "projection_record_count": len(projected_records),
                "projection_mode": oct(stat.S_IMODE(projection.stat().st_mode)),
                "recovery_user_message_id": recovery_user_id,
                "tool_name": call_name(call),
                "tool_call_message_id": int(call_row["id"]),
                "tool_call_id": call_id,
                "tool_call_arguments_sha256": hashlib.sha256(
                    call_arguments_json.encode()
                ).hexdigest(),
                "tool_result_message_id": int(tool_result["id"]),
                "tool_result_status": "successful",
                "tool_result_content_sha256": hashlib.sha256(
                    tool_result_text.encode()
                ).hexdigest(),
                "final_message_id": final_message_id,
                "final_answer": row_text(final.get("content")).strip(),
            }
        )
        success = True
    except Exception as exc:
        evidence["status"] = "failed"
        evidence["error_type"] = type(exc).__name__
        evidence["error"] = str(exc)
        raise
    finally:
        shutdown_error: AssertionError | None = None
        try:
            if child.isalive():
                child.sendline("/quit")
                try:
                    child.expect(pexpect.EOF, timeout=30)
                except pexpect.TIMEOUT:
                    child.close(force=True)
            child.close()
        except Exception as error:
            evidence["child_shutdown_exception"] = str(error)
            if success:
                shutdown_error = AssertionError(
                    "Hermes CLI shutdown raised an exception"
                )
                success = False
        evidence["child_exit_status"] = child.exitstatus
        evidence["child_signal_status"] = child.signalstatus
        if success and (child.exitstatus != 0 or child.signalstatus is not None):
            shutdown_error = AssertionError(
                "Hermes CLI did not exit cleanly after verification"
            )
            success = False

        projection_removed = projection_for_cleanup is None or not path_lexists(
            projection_for_cleanup
        )
        evidence["projection_cleanup"] = "removed" if projection_removed else "failed"
        if success and not projection_removed:
            shutdown_error = AssertionError(
                "Plugin finalization did not remove the derived session projection"
            )
            success = False

        if args.keep_home:
            evidence["isolated_home_cleanup"] = "retained-by-request"
        else:
            try:
                remove_tree_verified(root)
                evidence["isolated_home_cleanup"] = "removed"
            except Exception as error:
                evidence["isolated_home_cleanup"] = "failed"
                evidence["cleanup_error"] = str(error)
                shutdown_error = AssertionError(
                    "Credential-bearing isolated home cleanup failed"
                )
                success = False

        if success:
            evidence["status"] = "passed"
        elif evidence.get("status") != "failed":
            evidence["status"] = "failed"
        if shutdown_error is not None:
            evidence["shutdown_error"] = str(shutdown_error)
        evidence["completed_at_utc"] = datetime.now(timezone.utc).isoformat()
        write_secure_json(evidence_path, evidence)
        finalized["done"] = True
        print(f"[prolong-e2e] evidence: {evidence_path}")
        if args.keep_home:
            print(f"[prolong-e2e] isolated home retained: {root}")
        if shutdown_error is not None:
            raise shutdown_error

    print(
        "[prolong-e2e] PASS "
        f"session={evidence['session_id']} tool={evidence['tool_name']} "
        f"final_message={evidence['final_message_id']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
