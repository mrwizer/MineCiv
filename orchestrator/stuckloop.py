"""stuckloop.py — detect task-string repetition loops that the capability
classifier misses.

capabilities.py catches loops only when (a) the task maps to a known capability
and (b) it records 3 consecutive GIVE-UPS of that capability. That misses the two
loop shapes that actually dominate long runs:

  1. Monotonic-drift loops: "gather food within 20 blocks" -> 30 -> 50 -> ... -> 220.
     Every task string differs, many trivially "succeed" (the bot moves, finds
     nothing), and the intent buckets to `other`. The capability streak never trips.

  2. Verbatim-repeat loops: "Return to the surface and position near the crafting
     table at (6,86,-3)" proposed ~25 times, whether it succeeds, fails, or is a
     single-attempt no-op. Same reason: no give-up streak, so it's invisible.

This module works on the raw task TEXT, independent of capability class or verdict.
It normalizes a task (lowercase, strip trailing numbers/coords/radii, collapse
whitespace) to a "shape", then reports when the recent shapes are dominated by one
shape. That single boolean + the offending shape is injected into the proposer with
a hard directive to break pattern. It is the text-level twin of broken_block().
"""
import re

# how many recent tasks to consider, and how many of them must share a shape
# before we call it a loop.
WINDOW = 6
REPEAT_TRIP = 3          # >=3 of the last WINDOW sharing a shape == stuck
NEAR_DUP_TRIP = 3        # >=3 near-identical (drift) == stuck

_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_COORD = re.compile(r"\(?\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*\)?")
_RADIUS = re.compile(r"\b\d+\s*-?\s*block(?:s)?\b")
_WS = re.compile(r"\s+")
_STOP = re.compile(r"\b(the|a|an|to|and|of|my|at|in|on|near|using|with|for|"
                   r"nearest|available|existing|surface)\b")


def shape(task):
    """Reduce a task to its intent 'shape' by removing the parts that a drift
    loop varies (numbers, coordinates, radii) and low-signal filler words. Two
    tasks that are 'the same move with a different number' collapse to one shape."""
    t = (task or "").lower()
    t = _COORD.sub(" ", t)
    t = _RADIUS.sub(" ", t)
    t = _NUM.sub(" ", t)
    t = _STOP.sub(" ", t)
    t = _WS.sub(" ", t).strip()
    return t


def detect(recent_tasks):
    """recent_tasks: list of raw task strings, oldest-first. Returns
    {"stuck": bool, "shape": str, "count": int, "kind": "repeat"|"drift"|None}.

    'repeat'  = the same shape proposed >=REPEAT_TRIP times in the window.
    'drift'   = same shape AND the raw strings differ (the radius-climbing case),
                which we call out with a stronger 'you are only changing a number'
                message.
    """
    tasks = [t for t in (recent_tasks or []) if t]
    if len(tasks) < REPEAT_TRIP:
        return {"stuck": False, "shape": "", "count": 0, "kind": None}
    window = tasks[-WINDOW:]
    shapes = [shape(t) for t in window]
    # most common shape in the window
    best = max(set(shapes), key=shapes.count)
    count = shapes.count(best)
    if count < REPEAT_TRIP or not best:
        return {"stuck": False, "shape": "", "count": 0, "kind": None}
    # distinguish verbatim-repeat from number-drift: if the raw strings that share
    # this shape are NOT all identical, it's a drift loop (changing only a number).
    raws = [window[i] for i, s in enumerate(shapes) if s == best]
    kind = "repeat" if len(set(raws)) == 1 else "drift"
    return {"stuck": True, "shape": best, "count": count, "kind": kind}


def block(recent_tasks):
    """A prompt block that fires a hard pattern-break directive when a text loop
    is detected. Empty string when not stuck (so it costs nothing normally)."""
    d = detect(recent_tasks)
    if not d["stuck"]:
        return ""
    if d["kind"] == "drift":
        body = (
            f"You have proposed the SAME action {d['count']} times in a row, changing "
            f"only a number/coordinate each time (pattern: \"{d['shape']}\"). Enlarging "
            f"a search radius or nudging a coordinate is NOT progress — it is a loop. "
            f"The thing you are looking for is not there, or the approach cannot work. "
            f"STOP this pattern entirely.")
    else:
        body = (
            f"You have proposed essentially the SAME task {d['count']} times in a row "
            f"(pattern: \"{d['shape']}\") and you are no closer. This is a stuck loop. "
            f"Repeating it again will not work.")
    return (
        "STUCK LOOP DETECTED (obey — this overrides your default next step):\n"
        + body + "\n"
        "Do ONE of these instead, and pick the FIRST that applies:\n"
        "  (a) If you were trying to REACH a place and could not, you are likely "
        "physically stuck or the path is blocked — call helpers.getUnstuck() this "
        "cycle, or build/dig a route, rather than re-issuing the same 'go to' task.\n"
        "  (b) If you were SEARCHING for something absent (food, a tree, ore) — stop "
        "searching wider and PRODUCE it instead (e.g. plant crops/saplings, dig down "
        "to stone) or switch to a different part of your goal.\n"
        "  (c) If a prerequisite is missing, target that prerequisite directly.\n"
        "  (d) Otherwise choose a CATEGORICALLY DIFFERENT task that still serves your "
        "purpose. Do not propose the looped pattern again this cycle."
    )
