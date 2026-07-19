"""lessons.py — a self-improving memory of lessons the agents write themselves.

This is the piece that breaks the "human edits a prompt after every failure" loop.
When a bot gives up on a task, it asks the actor model to distill a SHORT, GENERAL
lesson ("don't dig straight down; you'll fall and get stuck"). That lesson is stored
and injected into every future propose/code prompt for ALL bots. A mistake made once
becomes knowledge the whole society keeps — with no human in the loop.

Lessons are deduplicated by similarity and capped, so the file stays a tight,
high-signal list instead of an ever-growing log.
"""
import json
import os
import re
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LESSONS = os.path.join(ROOT, "state", "lessons.json")
_lock = threading.Lock()

MAX_LESSONS = 20            # keep the list tight; drop least-reinforced when over
SIM_THRESHOLD = 0.4        # if a new lesson overlaps an old one this much, merge
                           # (lower = more aggressive merging of near-duplicates,
                           #  which is what collapses the 39 "verify inventory"
                           #  variants into one weighted entry)

# common filler words that shouldn't count toward lesson similarity
_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "then", "so", "because", "you",
    "your", "yourself", "it", "its", "to", "of", "in", "into", "on", "at", "for",
    "with", "from", "by", "is", "are", "be", "will", "can", "do", "dont", "don",
    "not", "no", "never", "always", "will", "get", "got", "this", "that", "them",
    "they", "as", "up", "down", "out", "off", "t", "s", "re", "when", "while",
}


def _load():
    if os.path.exists(LESSONS):
        with open(LESSONS) as f:
            return json.load(f)
    return []


def _save(items):
    os.makedirs(os.path.dirname(LESSONS), exist_ok=True)
    tmp = LESSONS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(items, f, indent=2)
    os.replace(tmp, LESSONS)


def _words(s):
    return set(re.findall(r"[a-z]+", s.lower())) - _STOP


def _similar(a, b):
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)   # Jaccard overlap


def add_lesson(text, source_task=""):
    """Store a self-authored lesson. Merges with a near-duplicate (bumping its
    weight) instead of adding a redundant entry."""
    text = text.strip()
    if not text:
        return
    with _lock:
        items = _load()
        for it in items:
            if _similar(text, it["text"]) >= SIM_THRESHOLD:
                it["weight"] = it.get("weight", 1) + 1
                it["last_seen"] = time.strftime("%Y-%m-%d %H:%M")
                _save(items)
                return
        items.append({
            "text": text,
            "from_task": source_task[:80],
            "weight": 1,
            "last_seen": time.strftime("%Y-%m-%d %H:%M"),
        })
        # cap: keep the most-reinforced lessons
        items.sort(key=lambda x: x.get("weight", 1), reverse=True)
        del items[MAX_LESSONS:]
        _save(items)


def lessons_block(limit=8):
    """Compact, ranked text of the top lessons for injection into prompts.
    Capped low on purpose: free-text lessons are a WEAK signal (they inform the
    model but gate nothing). The strong signals are the derived, structured blocks
    — bootstrap (inventory), blocked prerequisites, and blocked capabilities. Keep
    this list short so those aren't drowned out by a wall of near-duplicate
    'verify inventory after mining' reminders."""
    items = _load()
    if not items:
        return "(no lessons learned yet)"
    items.sort(key=lambda x: x.get("weight", 1), reverse=True)
    return "\n".join(f"- {it['text']}" for it in items[:limit])
