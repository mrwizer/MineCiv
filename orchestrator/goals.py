"""goals.py — per-bot long-term goal progress, so a bot pursues a standing
ambition across many cycles instead of picking unrelated tasks each time.

Think of it as the bot's project journal: "my goal is X; here's what I've done
toward it so far." Injected into the proposer each cycle so task selection ladders
toward the goal — the "I'm slowly working toward this" behavior of a human player.
"""
import json
import os
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROGRESS = os.path.join(ROOT, "state", "goal_progress.json")
_lock = threading.Lock()

MAX_STEPS = 25   # rolling history of accomplishments per bot


def _load():
    if os.path.exists(PROGRESS):
        with open(PROGRESS) as f:
            return json.load(f)
    return {}


def _save(d):
    os.makedirs(os.path.dirname(PROGRESS), exist_ok=True)
    tmp = PROGRESS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, PROGRESS)


def record_step(username, task):
    """Log a completed task as progress toward this bot's goal."""
    with _lock:
        d = _load()
        entry = d.setdefault(username, {"steps": []})
        entry["steps"].append({"did": task, "t": time.strftime("%Y-%m-%d %H:%M")})
        entry["steps"] = entry["steps"][-MAX_STEPS:]
        _save(d)


def progress_block(username):
    """What this bot has accomplished toward its goal, for the proposer prompt."""
    with _lock:
        d = _load()
    steps = d.get(username, {}).get("steps", [])
    if not steps:
        return "(nothing yet — this is the start of your project)"
    return "\n".join(f"- {s['did']}" for s in steps[-12:])
