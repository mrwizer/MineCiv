"""structures.py — a shared registry of community infrastructure.

The individualism problem: each bot builds its own crafting table / furnace / chest
because it has no awareness of what the group already made. This registry is the
shared memory of placed infrastructure. It's populated from REALITY (a bot reports
a structure it actually placed, with coordinates), and injected into every bot's
context so they can choose to reuse rather than duplicate.

Design stance: this provides PERCEPTION (what exists + where), not BEHAVIOR. Whether
a bot reuses shared infrastructure or builds its own is left to the agent — but now
it can at least SEE what's there. Checking before duplicating is competence, not a
scripted rule.
"""
import json
import math
import os
import re
import threading
import time

import store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "state", "structures.json")   # legacy (migration only)
_KEY = "structures"          # single kv key holding the whole registry dict
_lock = threading.Lock()

# structure types worth tracking as shared infrastructure
SHARED_TYPES = {
    "crafting_table", "furnace", "blast_furnace", "smoker", "chest",
    "barrel", "smithing_table", "anvil", "brewing_stand", "enchanting_table",
    "bed", "campfire", "cartography_table", "loom", "stonecutter",
}

_DEFAULT = {"structures": [], "workshop": None, "workshop_need": None}
_migrated = False


def _migrate_once():
    """One-time import of legacy structures.json into the store, if the store has
    nothing yet. Keeps an in-progress world from losing its registry on upgrade."""
    global _migrated
    if _migrated:
        return
    _migrated = True
    if store.kv_get(_KEY) is not None:
        return                                  # store already has data
    if os.path.exists(REGISTRY):
        try:
            with open(REGISTRY) as f:
                store.kv_set(_KEY, json.load(f))
        except Exception:
            pass


# _load/_save now back onto SQLite (store) instead of a JSON file. Every function
# in this module goes through these two, so this single swap migrates the whole
# registry to concurrent-safe storage with NO change to the 15+ public functions.
def _load():
    _migrate_once()
    return store.kv_get(_KEY, default=dict(_DEFAULT)) or dict(_DEFAULT)


def _save(d):
    store.kv_set(_KEY, d)


# ---- WORKSHOP: the community's designated build site ------------------------
# Mason (the decider) chooses WHERE the workshop is, using his own reasoning. Once
# established, shared infrastructure clusters there instead of being dropped wher-
# ever a bot happens to stand. This is the "civilization has a workshop" behavior:
# a place that accretes a table, furnace, chests over time. The SITING decision is
# the LLM's; this module only stores the decision and the demand signal for it.

def get_workshop():
    """The established workshop site {x,y,z,by,t,contents:[...]} or None."""
    with _lock:
        return _load().get("workshop")


def establish_workshop(x, y, z, by=""):
    """Record the workshop site the decider chose. First-write-wins: once a site
    exists it isn't silently relocated (relocation/voting is future work). Clears
    any outstanding demand signal, since the need is now met."""
    with _lock:
        d = _load()
        if d.get("workshop"):
            return d["workshop"]           # already established; keep it
        d["workshop"] = {"x": round(x, 1), "y": round(y, 1), "z": round(z, 1),
                         "by": by, "t": time.strftime("%Y-%m-%d %H:%M"),
                         "contents": []}
        d["workshop_need"] = None          # demand satisfied
        _save(d)
        return d["workshop"]


def signal_workshop_need(by=""):
    """A bot needed shared infrastructure but no workshop exists yet. Post/raise
    the demand. Each call while unmet bumps an age counter so the proposer can
    ESCALATE the priority on the decider until it's acted on — 'signal to get it
    done', getting louder until it binds, without hardcoding the decider's choice."""
    with _lock:
        d = _load()
        if d.get("workshop"):
            return                         # already have one; nothing to signal
        need = d.get("workshop_need")
        if need:
            need["age"] = need.get("age", 0) + 1
            need["last_by"] = by
        else:
            need = {"age": 0, "first_by": by, "last_by": by,
                    "t": time.strftime("%Y-%m-%d %H:%M")}
        d["workshop_need"] = need
        _save(d)


def bump_workshop_need():
    """Called once per decider cycle the need remains unmet, to age the demand
    even when no new bot re-signals it (so pressure rises with time, not just with
    repeated requests)."""
    with _lock:
        d = _load()
        if d.get("workshop") or not d.get("workshop_need"):
            return
        d["workshop_need"]["age"] = d["workshop_need"].get("age", 0) + 1
        _save(d)


def workshop_need():
    """Current demand signal {age,...} or None."""
    with _lock:
        return _load().get("workshop_need")


def add_workshop_contents(kind):
    """Note that a piece of shared infrastructure now lives at the workshop."""
    with _lock:
        d = _load()
        if d.get("workshop") is not None:
            c = d["workshop"].setdefault("contents", [])
            if kind not in c:
                c.append(kind)
                _save(d)


def register(kind, x, y, z, by=""):
    """Record a placed structure. De-dupes by near-identical coordinates so the
    same table isn't logged twice."""
    if kind not in SHARED_TYPES:
        return
    with _lock:
        d = _load()
        for s in d["structures"]:
            if s["kind"] == kind and abs(s["x"] - x) < 1 and abs(s["y"] - y) < 1 \
                    and abs(s["z"] - z) < 1:
                return  # already known
        d["structures"].append({
            "kind": kind, "x": round(x, 1), "y": round(y, 1), "z": round(z, 1),
            "by": by, "t": time.strftime("%Y-%m-%d %H:%M"),
        })
        _save(d)


def sync_from_scan(scan, by=""):
    """Given a list of {kind,x,y,z} a bot factually observed nearby, register any
    that are shared infrastructure. Keeps the registry grounded in reality."""
    for s in scan or []:
        register(s.get("kind"), s.get("x"), s.get("y"), s.get("z"), by=by)


def nearest(kind, x, y, z):
    """Return the nearest known structure of a kind to a point, or None."""
    with _lock:
        d = _load()
    best, bd = None, 1e9
    for s in d["structures"]:
        if s["kind"] != kind:
            continue
        dist = math.dist((x, y, z), (s["x"], s["y"], s["z"]))
        if dist < bd:
            bd, best = dist, s
    return (best, round(bd, 1)) if best else (None, None)


def registry_block(near=None):
    """Compact text of known community infrastructure for prompt injection.
    If `near`=(x,y,z) given, annotates distance so the agent knows what's close."""
    with _lock:
        d = _load()
    if not d["structures"]:
        return "(no shared community structures known yet)"
    # group by kind, show count + nearest
    by_kind = {}
    for s in d["structures"]:
        by_kind.setdefault(s["kind"], []).append(s)
    lines = []
    for kind, items in sorted(by_kind.items()):
        line = f"- {kind}: {len(items)} known"
        if near:
            n, dist = nearest(kind, *near)
            if n is not None:
                line += f" (nearest at {n['x']},{n['y']},{n['z']}, ~{dist} blocks away)"
        lines.append(line)
    return "\n".join(lines)


# ------------------------------------------------------------------------------
# VILLAGE PLAN — the shared artifact that turns scattered building into a village.
# Inspired by how Project Sid agents stayed coherent by planning against a common
# reference (a shared doc) rather than each agent improvising. The DECIDER (Mason,
# the city builder) proposes the layout; BOTH agents read it, CLAIM a slot, build
# it, and mark it done. This is what makes Mason's wall and Garrick's lighting line
# up into one settlement instead of two piles of blocks.
#
# The system does NOT choose the layout — that's a strategic decision, so the LLM
# (Mason) designs it. The system only STORES it and coordinates who-builds-what.
#
# Plan shape in structures.json:
#   "plan": {
#     "by": "Mason", "t": "...", "origin": {x,y,z},   # origin = anchor (workshop)
#     "slots": [
#        {"id":"wall_n","name":"north wall","kind":"wall",
#         "pos":{x,y,z}, "status":"planned|claimed|built", "by":null}
#     ]}

def get_plan():
    """The current village plan, or None if none proposed yet."""
    with _lock:
        return _load().get("plan")


def set_plan(by, origin, slots):
    """Decider proposes/replaces the village plan. slots: list of
    {id,name,kind,pos:{x,y,z}}. Preserves status/claims for slots whose id already
    existed, so re-planning doesn't wipe work already done."""
    with _lock:
        d = _load()
        prev = {s["id"]: s for s in (d.get("plan") or {}).get("slots", [])}
        norm = []
        for s in slots:
            sid = str(s.get("id") or s.get("name", "")).strip()
            if not sid:
                continue
            old = prev.get(sid, {})
            norm.append({
                "id": sid,
                "name": s.get("name", sid),
                "kind": s.get("kind", "structure"),
                "pos": s.get("pos", old.get("pos")),
                "status": old.get("status", "planned"),
                "by": old.get("by"),
            })
        d["plan"] = {"by": by, "t": time.strftime("%Y-%m-%d %H:%M"),
                     "origin": origin, "slots": norm}
        _save(d)
        return d["plan"]


def claim_slot(slot_id, by):
    """An agent claims a planned slot so the other doesn't duplicate it.
    Returns the slot, or None if not found. First-claim-wins on unclaimed slots;
    an already-claimed slot is returned unchanged (caller sees who holds it)."""
    with _lock:
        d = _load()
        plan = d.get("plan")
        if not plan:
            return None
        for s in plan["slots"]:
            if s["id"] == slot_id:
                if s["status"] == "planned":
                    s["status"] = "claimed"
                    s["by"] = by
                    _save(d)
                return s
        return None


def complete_slot(slot_id, by):
    """Mark a slot built. Returns the slot or None."""
    with _lock:
        d = _load()
        plan = d.get("plan")
        if not plan:
            return None
        for s in plan["slots"]:
            if s["id"] == slot_id:
                s["status"] = "built"
                s["by"] = by
                _save(d)
                return s
        return None


def plan_block(username=None):
    """Compact text of the village plan for prompt injection, so both agents see
    the shared layout and what's still open to build."""
    with _lock:
        d = _load()
    plan = d.get("plan")
    if not plan:
        return ("(no village plan yet — if you are the city builder, propose one: a "
                "simple layout of named build sites anchored at the workshop, so the "
                "community builds one coherent settlement instead of scattering)")
    lines = [f"Village plan by {plan['by']} (anchor {plan.get('origin')}):"]
    for s in plan["slots"]:
        pos = s.get("pos")
        posstr = f"@({pos['x']},{pos['y']},{pos['z']})" if pos else "(no pos)"
        tag = s["status"].upper()
        who = f" [{s['by']}]" if s.get("by") else ""
        mine = "  <-- yours" if username and s.get("by") == username else ""
        lines.append(f"  - {s['name']} ({s['kind']}) {posstr}: {tag}{who}{mine}")
    open_slots = [s for s in plan["slots"] if s["status"] == "planned"]
    if open_slots:
        lines.append(f"OPEN slots you could claim & build: "
                     + ", ".join(s["id"] for s in open_slots))
    return "\n".join(lines)


# soft cap: after this many unmet cycles, the decider's prompt stops treating
# "site the workshop" as one option among many and makes it the cycle's job.
WORKSHOP_NEED_HARDEN_AT = 4


# ------------------------------------------------------------------------------
# STRUCTURE PURPOSE — the GOALS a structure serves, never its shape.
#
# The gap this fills: bots could place blocks and coordinate WHO builds WHERE, but
# had no notion of what a building is FOR. Result: pillars + a chest that enclose
# nothing, no roof, no door — "built" per the plan, useless in reality.
#
# Design stance (owner's call): describe the FUNCTION the structure must achieve
# and let the LLM decide the FORM. We deliberately do NOT prescribe "4 walls + roof
# + door" — that would just reproduce our idea of a building. By stating goals
# ("keep mobs out", "keep rain off", "a safe place to sleep") we get to SEE what the
# LLM independently decides accomplishes them. If it invents something unexpected
# that still meets the goal, that's a finding, not a bug. The critic does NOT judge
# this (geometry is too hard to grade reliably); the human watches the results.
def critic_goals_block():
    """The SHORT form of purpose_block(), for the CRITIC.

    The critic runs on the small model with a small context window. Sending it the
    full purpose_block() (~2.5k chars of proposer-facing guidance) is what pushed the
    critic request past the window and produced 400 Bad Request on every judge call.
    The critic doesn't need the design advice or the 'name the structure concretely'
    instruction — it only needs to know what each structure TYPE is supposed to
    achieve, so it grades against purpose instead of block count."""
    return (
        "WHAT THE STRUCTURE TYPES ARE FOR (grade the build against its PURPOSE, not "
        "the number of blocks placed):\n"
        "  - SHELTER: encloses a space — mobs can't walk in, there's a cover "
        "overhead, and there's a way in and out. Walls with no roof, or an open "
        "side, do not yet achieve this.\n"
        "  - WALL / PERIMETER: a continuous barrier with NO gaps a mob fits through, "
        "tall enough not to be climbed, enclosing the area.\n"
        "  - STORAGE: containers the group can reach, clustered at the workshop.\n"
        "  - LIGHTING: enough light coverage to stop mobs spawning in the area.\n"
        "A build run is PROGRESS if it advanced the named structure toward that "
        "purpose. It is NOT progress if blocks were placed somewhere unrelated to it."
    )


def purpose_block():
    """GOALS ONLY — what structures are FOR. Injected into the PROPOSER (so it
    plans structures that serve a purpose) and into the CRITIC (so it grades a
    build against the purpose, not the block count).

    NOTE: build MECHANICS (groundY, buildBlocks, physics, reading the map) used to
    live in this same string, which meant they were only ever shown to the proposer
    — the model that does NOT write code. The coder never saw a word of them and so
    hardcoded Y values and ignored placeAt failures, which is what produced the
    incoherent structures. Mechanics now live in build_mechanics_block() and are
    injected into the CODE prompt. Keep this split: goals -> proposer/critic,
    mechanics -> coder."""
    return (
        "WHAT YOUR STRUCTURES ARE FOR (build toward these GOALS — the shape is your "
        "design decision, but the structure must actually ACHIEVE its purpose, not "
        "just be a few blocks placed):\n"
        "  - SHELTER: a place that protects whoever is inside. Its goals: keep "
        "hostile mobs OUT (they must not be able to walk or path in, and can't "
        "reach you at night), keep the ELEMENTS out (a cover overhead so rain/sky "
        "can't get in), and give a safe, enclosed space to stand and sleep with a "
        "way to get in and out. A cluster of pillars or a single wall does NOT "
        "achieve this — ask yourself: if a zombie walked up right now, or it "
        "started raining, would someone inside be protected? If not, it's not a "
        "shelter yet.\n"
        "  - DEFENSIVE WALL / PERIMETER: its goal is to keep the settlement's area "
        "safe — a continuous barrier with NO gaps a mob could slip through, tall "
        "enough that they can't get over, enclosing the space you're protecting.\n"
        "  - STORAGE: its goal is that the group's materials are kept safe and "
        "findable — containers placed where everyone can reach them, at the "
        "workshop, not scattered.\n"
        "  - LIGHTING: its goal is to stop mobs spawning in your area — enough light "
        "coverage that the settlement floor stays lit at night.\n"
        "When you propose a build task, state (in your reasoning) WHICH goal it "
        "serves and HOW your design achieves it. If what exists so far does not yet "
        "achieve the goal (e.g. a shelter with no roof or an open side), your next "
        "build task should be the piece that DOES — finish the enclosure, add the "
        "cover, close the gap — rather than starting something new. A half-built "
        "structure that protects no one is not done.\n"
        "NAME THE STRUCTURE CONCRETELY IN THE TASK. The coder receives ONLY your "
        "task string and success_looks_like — it cannot see your reasoning, the "
        "village plan, or this text. So a task like 'place some blocks for the "
        "shelter' tells it nothing and you will get scattered blocks. Instead give "
        "it the DESIGN: what shape, what footprint, anchored WHERE, and which part "
        "of it this cycle builds. For example: 'Build the 5x5 shelter walls at "
        "(-104,-78), 2 courses high on top of the existing floor, leaving a 1-block "
        "door gap on the south side' — that is buildable. 'Continue the shelter' is "
        "not.\n"
        "MARKING COMPLETE: only mark a structure's plan slot complete once it "
        "actually SERVES ITS PURPOSE — check the map and ask honestly: is it fully "
        "enclosed / does it truly protect? If not, it is NOT done; keep building the "
        "missing pieces and note on the blackboard what still remains. Don't declare "
        "a half-structure finished."
    )


def build_mechanics_block():
    """MECHANICS ONLY — how to physically build. Injected into the CODE prompt
    (prompts.code_prompt), because the CODER is the model that must obey this.

    This text was previously inside purpose_block() and therefore went only to the
    proposer. That is the root cause of the 95 failed placements and the roofs
    floating above 2-block walls: the model writing the placement coordinates was
    never told how placement physics works, never told groundY existed, and never
    told to read placeAt's failure reason."""
    return (
        "HOW TO BUILD (read this before writing any placement code):\n"
        "- `helpers.buildBlocks(cells, name)` IS YOUR BUILD VERB. You design the "
        "list of {x,y,z} cells — a box, an L, walls with a door gap, a roof, any "
        "shape — and pass them in one call. Do NOT hand-write a loop of placeAt "
        "calls; buildBlocks orders cells bottom-up so nothing floats, walks to each "
        "one, and returns {placed, already, failed, failures:[{x,y,z,reason}]}.\n"
        "- NEVER GUESS A Y COORDINATE, AND NEVER DO ARITHMETIC ON THE surfaceHeights "
        "GRID. That grid is indexed by OFFSET FROM THE BOT, not by world coordinate, "
        "and every attempt to do math on it has placed blocks inside solid terrain "
        "(95 failures in one run: 'placement didn't stick' = your Y was inside the "
        "ground). Instead do ONE of these two things:\n"
        "    (a) For the FLOOR / footprint: pass cells with NO y at all — just "
        "{x,z}. Each block then lands on the real ground surface of that column "
        "automatically. This is the easiest correct move.\n"
        "    (b) Call `helpers.groundY(x, z)` for the column you care about. It "
        "returns {groundY, floorY, found} in ABSOLUTE WORLD COORDINATES. floorY "
        "(= groundY+1) is where the first course sits. Build higher courses at "
        "floorY+1, floorY+2, ... relative to THAT number.\n"
        "- PHYSICS: a block cannot float. Every block needs a solid block already "
        "below or beside it. So build GROUND UP: floor, then wall course 1, then "
        "wall course 2, then the roof. A roof only works if the walls it rests on "
        "ALREADY EXIST at the course below it. If you place a 2-course wall "
        "(floorY+1, floorY+2), the roof goes at floorY+3 — not at some Y you "
        "remembered from an earlier task.\n"
        "- READ THE RESULT AND REACT. buildBlocks tells you exactly why each cell "
        "failed (no_support_neighbour, no_item, submerged, place_did_not_stick). "
        "`no_support_neighbour` / `place_did_not_stick` means your DESIGN was wrong "
        "for that cell — the coordinate was floating, or inside terrain. Do NOT "
        "retry the same coordinate; recompute it from groundY, or place the "
        "supporting block underneath it first. Retrying an identical failing "
        "coordinate is the single most common way these builds are wasted.\n"
        "- VERIFY BEFORE STACKING. If this task adds a layer ON TOP of something "
        "(a roof on walls, a second course), do not assume the layer below is where "
        "you think it is. Check `spatialMap` in your game state (see below), or "
        "re-derive the height from groundY, before choosing the new layer's Y.\n"
        "- USE `spatialMap` — IT IS IN YOUR GAME STATE AND IT IS THE ONLY WAY YOU "
        "CAN SEE WHAT IS ACTUALLY BUILT. It is a top-down character grid (radius 5 "
        "around you, with a legend) showing the topmost block of each column: walls, "
        "gaps, what's already placed. READ IT before designing your cells. It is how "
        "you find the hole in a wall you're supposed to be closing, and how you tell "
        "whether the structure you're adding to actually exists. Do not build blind "
        "off block COUNTS in nearbyBlockCensus — a count of 40 cobblestone tells you "
        "nothing about whether there is a gap a mob can walk through. Its `origin` "
        "field gives the world coords of the grid centre, so you can convert a grid "
        "cell to a world coordinate.\n"
        "- If the task names a structure with a footprint and an anchor (e.g. 'the "
        "5x5 shelter walls at (-104,-78)'), BUILD THAT SHAPE — compute the full "
        "perimeter of cells and pass them all to buildBlocks in one call. Placing a "
        "few blocks 'toward' it is not building it."
    )


def workshop_block(is_decider=False, near=None):
    """Prompt text describing the workshop's status, tailored to whether THIS bot
    is the decider. For the decider, an unmet need ESCALATES with age until it's
    the clear top priority — 'push by priority to Mason to make him.'"""
    ws = get_workshop()
    if ws:
        contents = ", ".join(ws.get("contents", [])) or "nothing yet"
        line = (f"The community WORKSHOP is established at "
                f"{ws['x']},{ws['y']},{ws['z']} (has: {contents}). Place shared "
                f"infrastructure (tables, furnaces, chests) THERE — pathfind to it "
                f"and build adjacent to what's already there, so it grows as one "
                f"workshop instead of scattered blocks.")
        if near:
            try:
                dist = round(math.dist((near[0], near[1], near[2]),
                                       (ws["x"], ws["y"], ws["z"])), 1)
                line += f" It is ~{dist} blocks from you."
            except Exception:
                pass
        return line

    need = workshop_need()
    if not is_decider:
        if need:
            return ("No community workshop exists yet. You needed shared "
                    "infrastructure and have signalled that the workshop must be "
                    "sited. Until the decider establishes it, do OTHER useful work "
                    "you can do now — do not sit idle, and do not found the "
                    "workshop yourself (that is the decider's call).")
        return ("No community workshop exists yet. If you need shared "
                "infrastructure (a table/furnace/chest) and there's none nearby, "
                "you may place a temporary one on good open ground and keep working "
                "— but siting the permanent workshop is the decider's job.")

    # --- decider's view: no workshop sited yet ---
    if not need:
        return (">>> As the community's builder you are the DECIDER for where home "
                "is. No community workshop/home has been sited yet, and a "
                "civilization needs a center EARLY — before infrastructure gets "
                "scattered. Soon (ideally within your first few cycles, once you "
                "have basic tools), CHOOSE a good home location with your own "
                "judgment — flat, open ground near where the group is working, not "
                "in trees or on a cliff — and establish it. This is where all shared "
                "tables, furnaces, and chests will cluster, so everyone returns here "
                "instead of building their own. Siting it is YOUR call; pick well.")
    age = need.get("age", 0)
    if age >= WORKSHOP_NEED_HARDEN_AT:
        return (f">>> TOP PRIORITY: the community has been BLOCKED on a workshop for "
                f"{age} cycles. Unless something is an immediate emergency, your task "
                f"THIS cycle is to CHOOSE the workshop location and establish it. "
                f"Pick flat, open ground near where the group works (not in trees, not "
                f"on a cliff edge) and site it now. The group is waiting on you.")
    urgency = ["", "This has been outstanding and is becoming urgent. ",
               "This is now urgent — the community is waiting. ",
               "This is overdue and blocking the group. "][min(age, 3)]
    return (f"A workshop is NEEDED and has been requested (outstanding {age} "
            f"cycle(s)). {urgency}As the decider, siting the community workshop "
            f"should be your priority: choose flat, open ground near where the "
            f"group works (not in trees or on a cliff) and establish it soon.")


# ==============================================================================
# PERSISTENT LLM-AUTHORED DESIGNS — the fix for incoherent, drifting structures.
#
# The problem: each cycle the builder re-derived a structure's coordinates from
# scratch, so a multi-cycle build never converged — walls half-here, a roof
# floating over yesterday's guess. This module lets the LLM author a DESIGN ONCE
# (a named list of {x,y,z} cells it reasoned out, plus the purpose and material),
# persist it, and then build + verify it INCREMENTALLY across cycles against the
# real world. The runner re-checks which cells are actually placed each cycle and
# feeds the still-missing ones back, so the builder finishes the SAME structure
# instead of starting a new one.
#
# Fidelity note (GOVERNANCE_PLAN.md): the SHAPE is 100% the LLM's decision — this
# module stores and verifies it, nothing more. It hardcodes no geometry. It is the
# block-granularity twin of the village PLAN (which coordinates who-builds-what);
# here we coordinate a single structure's build ACROSS TIME so it comes out whole.
# Designs live in the registry under "designs": { id: {..} }.

def _slug_design(name):
    s = re.sub(r"[^a-z0-9_]+", "_", (name or "structure").lower()).strip("_")
    return s or "structure"


def save_design(username, name, purpose, block, cells, origin=None, plan_slot=None):
    """Store an LLM-authored design. cells = [{x,y,z}, ...] (absolute world coords).
    Returns the stored design dict (with a generated id). Skips malformed cells."""
    clean = []
    seen = set()
    for c in cells or []:
        try:
            x, y, z = int(round(c["x"])), int(round(c["y"])), int(round(c["z"]))
        except (KeyError, TypeError, ValueError):
            continue
        k = (x, y, z)
        if k in seen:
            continue
        seen.add(k)
        clean.append({"x": x, "y": y, "z": z})
    # A design with no valid cells is useless AND dangerous: an empty cell list has
    # nothing "missing", so downstream logic would read it as already-complete and
    # the builder would be permanently blocked from ever building that structure.
    # Refuse to store it; the caller falls back to the normal build flow.
    if not clean:
        return None
    with _lock:
        d = _load()
        designs = d.setdefault("designs", {})
        base = _slug_design(name)
        did = base
        if did in designs:
            did = f"{base}_{str(int(time.time() * 1000))[-6:]}"
        designs[did] = {
            "id": did, "name": name or base, "purpose": (purpose or "structure"),
            "block": block or "cobblestone", "by": username,
            "cells": clean, "total": len(clean),
            "present": 0, "missing": [c.copy() for c in clean],
            "status": "in_progress", "plan_slot": plan_slot,
            "origin": origin, "t": time.strftime("%Y-%m-%d %H:%M"),
        }
        _save(d)
        return designs[did]


def get_design(design_id):
    with _lock:
        return (_load().get("designs") or {}).get(design_id)


def active_design_for(username):
    """The most recent still-in-progress design authored by this bot, or None.
    Lets a builder CONTINUE its unfinished structure even without passing an id."""
    with _lock:
        designs = (_load().get("designs") or {})
    mine = [v for v in designs.values()
            if v.get("by") == username and v.get("status") == "in_progress"
            and v.get("total", 0) > 0]   # ignore any 0-cell junk from older runs
    if not mine:
        return None
    mine.sort(key=lambda v: v.get("t", ""), reverse=True)
    return mine[0]


def update_design_progress(design_id, present_count, missing_cells):
    """Record a grounded verification result. missing_cells = [{x,y,z}, ...] the
    world still lacks. Marks the design complete when nothing is missing."""
    with _lock:
        d = _load()
        designs = d.get("designs") or {}
        des = designs.get(design_id)
        if not des:
            return None
        des["present"] = int(present_count)
        des["missing"] = list(missing_cells or [])
        if not des["missing"] and des.get("total", 0) > 0:
            des["status"] = "complete"
        des["t_verified"] = time.strftime("%Y-%m-%d %H:%M")
        _save(d)
        return des


def designs_block(username):
    """Compact text of THIS bot's in-progress designs, for the proposer — so a
    builder knows it has an unfinished structure to continue (and its id) rather
    than starting a new one."""
    with _lock:
        designs = (_load().get("designs") or {})
    mine = [v for v in designs.values()
            if v.get("by") == username and v.get("status") == "in_progress"
            and v.get("total", 0) > 0]
    if not mine:
        return ("(you have no unfinished structure design — when you start a build, "
                "one will be recorded so you can finish it over several cycles)")
    mine.sort(key=lambda v: v.get("t", ""), reverse=True)
    lines = ["YOUR UNFINISHED STRUCTURE DESIGNS (continue one instead of starting "
             "over — pass its id as \"design_id\" and set build_intent true):"]
    for v in mine[:4]:
        done, tot = v.get("present", 0), v.get("total", 0)
        lines.append(f"  - id \"{v['id']}\": {v['name']} ({v['purpose']}, {v['block']}) "
                     f"— {done}/{tot} blocks placed, {len(v.get('missing', []))} still missing")
    return "\n".join(lines)


# ==============================================================================
# COMMUNITY NEEDS — for the floating ("good citizen") members with no fixed role.
#
# A floater self-assigns the most useful job each cycle. To do that well it needs a
# FOCUSED view of what the group has asked for but nobody has done: open jobs in the
# village plan, an unmet workshop need, and recent requests / things others
# struggled with on the blackboard. This is a grounded aggregation of real state +
# real notes; it prescribes nothing.

_NEED_MARKERS = ("struggled with:", "need ", "needs ", "needed", "low on",
                 "request", "please", "help ", "short on", "out of", "waiting on",
                 "signalled", "signaled", "blocked")
_DONE_MARKERS = ("did:", "learned to:", "finished", "completed", "established",
                 "sited ", "revised skill")


def community_needs_block(recent_notes=None):
    """Aggregate unmet community needs for a floater's proposer. recent_notes is the
    blackboard notes list (each {by,text,t}); pass read_blackboard()['notes']."""
    lines = []

    # 1) open village-plan jobs anyone can claim + build
    with _lock:
        plan = (_load().get("plan"))
    if plan:
        open_slots = [s for s in plan.get("slots", []) if s.get("status") == "planned"]
        if open_slots:
            lines.append("OPEN village-plan jobs (claim one and build it): "
                         + ", ".join(f"{s.get('name', s['id'])} [{s['id']}]"
                                     for s in open_slots[:6]))

    # 2) an unmet workshop need
    need = workshop_need()
    if need and not get_workshop():
        lines.append(f"The community still has NO workshop sited (unmet for "
                     f"{need.get('age', 0)} cycle(s)); until the decider sites it, "
                     f"do other useful work.")

    # 3) recent requests / struggles on the blackboard that look UNMET
    notes = recent_notes or []
    reqs = []
    for n in notes:
        by = n.get("by", "?")
        txt = (n.get("text") or "").strip()
        low = txt.lower()
        if by == "?" or not txt:
            continue
        if any(m in low for m in _DONE_MARKERS):
            continue
        if any(m in low for m in _NEED_MARKERS):
            reqs.append(f"{by}: {txt[:120]}")
    if reqs:
        lines.append("Recent requests / things others struggled with (help if you "
                     "can — pick the one that unblocks the most):")
        lines.extend(f"  - {r}" for r in reqs[-6:])

    if not lines:
        return ("COMMUNITY NEEDS: nothing specific is outstanding right now. Look at "
                "the blackboard and shared infrastructure and pick the job that helps "
                "the group most (top up low materials, finish a partial build, defend, "
                "or farm) rather than idling.")
    return "COMMUNITY NEEDS (you are a flexible helper — take the most useful one):\n" \
           + "\n".join(lines)
