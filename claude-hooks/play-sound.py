#!/usr/bin/env python3
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

SOUNDS_BASE = Path(os.environ.get("SOUNDS_BASE", Path.home() / "Documents" / "sounds"))
MIN_INTERVAL_MS = int(os.environ.get("SOUND_MIN_INTERVAL_MS", "250"))
COOLDOWN_FILE = Path("/tmp/claude-sound-last-play")
DEBUG = os.environ.get("SOUND_DEBUG") == "1"
EXTENSIONS = {".mp3", ".aiff", ".wav", ".m4a", ".aif"}


def debug(msg: str) -> None:
    if DEBUG:
        print(f"[sound-hook] {msg}", file=sys.stderr)


def within_cooldown() -> bool:
    now_ms = int(time.time() * 1000)
    try:
        last_ms = int(COOLDOWN_FILE.read_text().strip())
        if now_ms - last_ms < MIN_INTERVAL_MS:
            debug(f"Cooldown: {now_ms - last_ms}ms < {MIN_INTERVAL_MS}ms")
            return True
    except (FileNotFoundError, ValueError):
        pass
    COOLDOWN_FILE.write_text(str(now_ms))
    return False


def find_sounds(sound_dir: Path) -> list[Path]:
    try:
        return [
            p for p in sound_dir.iterdir()
            if p.is_file() and p.suffix.lower() in EXTENSIONS
        ]
    except OSError:
        return []


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        debug("Failed to parse JSON from stdin")
        return

    event_name = data.get("hook_event_name", "")
    if not event_name:
        debug("No event name in input")
        return

    sound_dir = SOUNDS_BASE / event_name
    if not sound_dir.is_dir():
        debug(f"No sound directory: {sound_dir}")
        return

    if within_cooldown():
        return

    sounds = find_sounds(sound_dir)
    if not sounds:
        debug(f"No audio files in {sound_dir}")
        return

    sound = random.choice(sounds)
    debug(f"Playing: {sound}")

    subprocess.Popen(
        ["afplay", str(sound)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


if __name__ == "__main__":
    main()
