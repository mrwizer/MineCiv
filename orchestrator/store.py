"""store.py — shared SQLite state for concurrent bots (replaces file JSON for the
high-contention state as bot count grows).

Why: at 2 bots, read-modify-write on a JSON file under a Python lock is invisible.
At 10-20 bots it becomes a serialization point AND every write rewrites the whole
file. SQLite in WAL mode gives real concurrent readers + serialized writers with
row-level granularity, no full-file rewrites, and survives crashes.

WAL (Write-Ahead Logging) is the key: readers don't block writers and writers
don't block readers, so many bots reading the blackboard while one appends a note
don't stall each other.

This module is deliberately small and generic: a key/value table plus an append
table for notes. Higher-level modules (blackboard, structures) use it instead of
json.dump/load. Kept file-compatible in shape so migration is mechanical.
"""
import json
import os
import sqlite3
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "state", "mysid.db")

# One connection per thread (sqlite3 connections aren't safe to share across
# threads by default). WAL lets these separate connections read/write concurrently.
_local = threading.local()


def _conn():
    c = getattr(_local, "conn", None)
    if c is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.execute("PRAGMA journal_mode=WAL")       # concurrent readers + writer
        c.execute("PRAGMA synchronous=NORMAL")     # fast + still crash-safe under WAL
        c.execute("PRAGMA busy_timeout=30000")     # wait up to 30s for a lock
        c.row_factory = sqlite3.Row
        _local.conn = c
        _init(c)
    return c


def _init(c):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        t     REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        text   TEXT NOT NULL,
        t      TEXT NOT NULL
    );
    """)
    c.commit()


# ---- key/value (for structured blobs: plan, workshop, structures list) --------

def kv_get(key, default=None):
    row = _conn().execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key, value):
    c = _conn()
    c.execute("INSERT INTO kv(key,value,t) VALUES(?,?,?) "
              "ON CONFLICT(key) DO UPDATE SET value=excluded.value, t=excluded.t",
              (key, json.dumps(value), time.time()))
    c.commit()


def kv_update(key, fn, default=None):
    """Atomic read-modify-write within a single transaction, so two bots updating
    the same key can't clobber each other. fn(current) -> new_value."""
    c = _conn()
    c.execute("BEGIN IMMEDIATE")          # take the write lock up front
    try:
        row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        cur = json.loads(row["value"]) if row else default
        new = fn(cur)
        c.execute("INSERT INTO kv(key,value,t) VALUES(?,?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value, t=excluded.t",
                  (key, json.dumps(new), time.time()))
        c.commit()
        return new
    except Exception:
        c.rollback()
        raise


# ---- append-only notes (blackboard) ------------------------------------------

def note_add(author, text, keep=200):
    c = _conn()
    c.execute("INSERT INTO notes(author,text,t) VALUES(?,?,?)",
              (author, text, time.strftime("%H:%M:%S")))
    # trim to the most recent `keep` notes so the table can't grow unbounded
    c.execute("DELETE FROM notes WHERE id NOT IN "
              "(SELECT id FROM notes ORDER BY id DESC LIMIT ?)", (keep,))
    c.commit()


def notes_recent(limit=30):
    rows = _conn().execute(
        "SELECT author,text,t FROM notes ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    # return oldest-first for readable prompt injection
    return [{"by": r["author"], "text": r["text"], "t": r["t"]} for r in reversed(rows)]


def reset(hard=False):
    """Clear notes (and optionally kv) — used by reset_run.py for a fresh world."""
    c = _conn()
    c.execute("DELETE FROM notes")
    if hard:
        c.execute("DELETE FROM kv")
    c.commit()
