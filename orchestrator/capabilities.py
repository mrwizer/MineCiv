"""capabilities.py — a DERIVED, STRUCTURED health signal per capability.

The lessons file is free text appended to prompts: it can tell the model what to
*think*, but it cannot change what the model is *allowed to do*, so it never stops
the bot re-deriving the same dead subgoal. This module is the opposite: it watches
real outcomes and produces a small, machine-checkable fact — "the capability
'obtain cobblestone' has failed the last N cycles across every skill and phrasing"
— that the proposer is told to OBEY, not merely read.

A "capability" is the abstract thing a task is trying to do (mine_stone,
craft_wooden_pickaxe, gather_wood, ...), independent of which skill or wording was
used. We classify a task string into a capability with a few keyword rules; this is
the one bit of MC-domain structure we hardcode, and it is about *categorising
intent*, not about *how to do* anything.

When a capability's recent history is bad enough, propose_prompt surfaces it as a
BLOCKED CAPABILITY with a concrete instruction (pursue the prerequisite, or a
different branch). That is the same mechanism that already works well for the
inventory-derived bootstrap_block — structured, derived, decision-gating — applied
to failure history instead of inventory.
"""
import json
import os
import re
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP_FILE = os.path.join(ROOT, "state", "capabilities.json")
_lock = threading.Lock()

# How many recent attempts we keep per capability, and how many consecutive
# failures (with zero intervening success) marks a capability "broken".
WINDOW = 8
BROKEN_STREAK = 3

# Instrument phrases like "using a stone pickaxe" describe the TOOL, not the
# intent, and must not drive classification (else "mine coal using a stone
# pickaxe" mis-classifies as a stone task). Strip them before matching.
_TOOL_PHRASE = re.compile(
    r"\b(using|with)\s+(a|an|the|my|existing|available)?\s*"
    r"[a-z_]*\s*(pickaxe|axe|shovel|sword|hoe|tool)s?\b")

# Ordered rules mapping a task string -> capability id. First match wins, so the
# MOST SPECIFIC / primary-intent rules come first (the crafted end-item beats an
# Instrument phrases describe the TOOL/STATION used, not the intent, and must not
# drive classification: "mine coal using a stone pickaxe" is a coal task, and
# "craft a wooden pickaxe using the nearby crafting table" is a pickaxe task — the
# crafting table is the station, not the goal. Strip both before matching.
_TOOL_PHRASE = re.compile(
    r"\b(using|with|at|near|by)\s+(a|an|the|my|existing|available|nearby)?\s*"
    r"([a-z_]*\s*(pickaxe|axe|shovel|sword|hoe|tool)s?"
    r"|(nearby\s+|existing\s+)?crafting[_ ]?table)\b")

# Ordered rules mapping a task string -> capability id. First match wins, so the
# MOST SPECIFIC / primary-intent rules come first. A crafted end-item (pickaxe,
# sword) beats the generic crafting-table rule, which in turn only fires when the
# TABLE ITSELF is the thing being made (not merely used). These describe INTENT
# CATEGORIES, not procedures.
_RULES = [
    # placement / building (check before the item the thing is made of)
    ("place_torch",            r"\bplace\b.*\btorch"),
    ("build_structure",        r"\b(wall|fence|shelter|house|road|perimeter|building|storage|village)\b"),
    # movement / positioning loops: "navigate to / position near / return to the
    # surface / travel to X". These were the dominant repeat-loops (Garrick, Mason)
    # and previously fell through to 'other', so broken_block never escalated them.
    # Classify them as ONE capability so a run of them trips the broken streak.
    ("reach_location",         r"\b(return to the surface|position near|navigate to|travel to|move to|go to|reach|climb out|escape confinement|get to the surface)\b"),
    # searching/foraging loops: "gather/search for food/animals within N blocks".
    # The radius-drift loop (Rowan) buckets here instead of 'other'.
    ("forage_food",            r"\b(food|animal|animals|pig|cow|chicken|sheep|porkchop|hunt|forage)\b"),
    # specific crafted end-items FIRST (before the generic table rule and before
    # 'planks'/'sticks' ingredient mentions)
    ("craft_wooden_pickaxe",   r"\bwooden[_ ]pickaxe\b"),
    ("craft_stone_pickaxe",    r"\bstone[_ ]pickaxe\b"),
    ("craft_stone_sword",      r"\bstone[_ ]sword\b"),
    ("craft_torch",            r"\btorch(es)?\b"),
    # crafting a TABLE as the goal (instrument uses were stripped above, so a
    # surviving "table" mention means the table is the thing being made)
    ("craft_crafting_table",   r"\bcraft(ing)?[_ ]?table\b|\bcraft .*\btable\b"),
    # resource acquisition (intent = the resource, not the tool used)
    ("mine_coal",              r"\bcoal\b"),
    ("mine_iron",              r"\b(iron[_ ]ore|raw[_ ]iron|iron ingot|\biron\b)\b"),
    ("obtain_stone",           r"\b(cobblestone|cobbled_deepslate|stone block|mine\b.*\bstone\b)\b"),
    ("gather_wood",            r"\b(log|logs|wood|plank)\b"),
    ("gather_dirt",            r"\bdirt\b"),
    # lower-value intermediates last
    ("craft_sticks",           r"\bsticks?\b"),
    ("escape_hole",            r"\b(escape|unstuck|pillar up|get out of)\b"),
]


def classify(task):
    """Map a task string to a capability id (or 'other'). Tool-instrument phrases
    ('using a stone pickaxe') are stripped first so they don't hijack the match."""
    t = (task or "").lower()
    t = _TOOL_PHRASE.sub(" ", t)
    for cap, pat in _RULES:
        if re.search(pat, t):
            return cap
    return "other"


def _load():
    if os.path.exists(CAP_FILE):
        with open(CAP_FILE) as f:
            return json.load(f)
    return {}


def _save(d):
    os.makedirs(os.path.dirname(CAP_FILE), exist_ok=True)
    tmp = CAP_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, CAP_FILE)


def record(task, success, reason=""):
    """Record one outcome against the task's capability."""
    cap = classify(task)
    with _lock:
        d = _load()
        e = d.setdefault(cap, {"outcomes": [], "ok": 0, "fail": 0})
        e["outcomes"].append({
            "ok": bool(success),
            "task": (task or "")[:80],
            "reason": (reason or "")[:120],
            "t": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        e["outcomes"] = e["outcomes"][-WINDOW:]
        e["ok"] = sum(1 for o in e["outcomes"] if o["ok"])
        e["fail"] = sum(1 for o in e["outcomes"] if not o["ok"])
        _save(d)
    return cap


def _streak(entry):
    """Consecutive failures at the tail of the outcome window (0 if last was ok)."""
    n = 0
    for o in reversed(entry.get("outcomes", [])):
        if o["ok"]:
            break
        n += 1
    return n


def is_broken(cap):
    if cap == "other":
        return False   # 'other' is a catch-all, not a real capability — never block it
    with _lock:
        d = _load()
    e = d.get(cap)
    return bool(e) and _streak(e) >= BROKEN_STREAK


def broken_block():
    """A prompt block naming capabilities the bot keeps failing, with a directive
    to stop re-attempting them head-on. Empty string if nothing is broken."""
    with _lock:
        d = _load()
    broken = []
    for cap, e in d.items():
        if cap == "other":
            continue   # never surface the catch-all bucket as a blocked capability
        s = _streak(e)
        if s >= BROKEN_STREAK:
            last = e["outcomes"][-1].get("reason", "") if e["outcomes"] else ""
            broken.append((s, cap, last))
    if not broken:
        return ""
    broken.sort(reverse=True)
    lines = []
    for s, cap, last in broken:
        lines.append(f"- '{cap}' has failed {s} times in a row. "
                     f"Last reason: {last or '(none)'}")
    return (
        "BLOCKED CAPABILITIES (obey — do NOT keep retrying these head-on):\n"
        + "\n".join(lines)
        + "\nFor a blocked capability, do ONE of: (a) attempt the PREREQUISITE it "
          "depends on (e.g. if you can't obtain stone, first craft/equip the right "
          "pickaxe, or dig down to expose stone), or (b) switch to a DIFFERENT part "
          "of your goal for now. Do not propose the same blocked action again this "
          "cycle."
    )


def clear_if_recovered():
    """No-op hook kept for symmetry; recovery is automatic because a success
    resets the tail streak. Present so callers can be explicit if needed."""
    return
