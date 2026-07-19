"""runner.py — the Voyager loop. Runs one bot, or all of config.BOTS in threads.

  python runner.py            # runs every bot in config.BOTS concurrently
  python runner.py Mason      # runs just the named bot(s)
  python runner.py --debug    # ONLY the llama.cpp actor/critic bots; skip the vLLM
                              #   boxes so they can be freed for local LLM coding.
                              #   Omit the flag and ALL bots run again — no code change.
"""
import argparse
import json
import os
import sys
import threading
import time

import capabilities
import config
import goals
import lessons
import llm
import prompts
import skills
import store
import structures
import stuckloop
from bot_bridge import BotBridge

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(ROOT, "state")
LOG_DIR = os.path.join(ROOT, "logs")
BLACKBOARD = os.path.join(STATE_DIR, "blackboard.json")   # legacy path (migration)

# Blackboard now lives in SQLite (store.py) so many bots can read/append notes
# concurrently without file-lock serialization or full-file rewrites. The
# interface below is UNCHANGED so every caller keeps working — only the backing
# store swapped from JSON to WAL SQLite. A one-time migration imports any existing
# JSON notes so a run in progress doesn't lose its blackboard.

_bb_migrated = False
_bb_migrate_lock = threading.Lock()

def _migrate_bb_once():
    global _bb_migrated
    with _bb_migrate_lock:
        if _bb_migrated:
            return
        _bb_migrated = True
        # if the DB already has notes, assume migrated; else import legacy JSON
        try:
            if store.notes_recent(1):
                return
        except Exception:
            pass
        if os.path.exists(BLACKBOARD):
            try:
                with open(BLACKBOARD) as f:
                    old = json.load(f)
                for n in old.get("notes", []):
                    store.note_add(n.get("by", "?"), n.get("text", ""))
            except Exception:
                pass

def read_blackboard():
    """Returns the same shape callers expect: {"notes":[...], ...}. Notes come
    from the store (most-recent 30, oldest-first for readable prompt injection)."""
    _migrate_bb_once()
    return {"notes": store.notes_recent(30), "structures": [], "needs": []}

def write_blackboard(bb):
    """Only used to reset the board. Clears store notes; ignores the vestigial
    structures/needs fields (real structures live in structures.py)."""
    store.reset(hard=False)

def post_note(author, text):
    """Append a note. SQLite handles concurrency; no Python lock or full rewrite."""
    _migrate_bb_once()
    store.note_add(author, text)

import re as _re

def extract_missing(run):
    """Pull a list of missing prerequisites from a run result. craftItem returns
    {ok:false, missing:[{name,count}], reason:"...missing: 3 x, 2 y"}. The skill
    may return that object directly (run.result.missing) OR only emit the reason
    into logs. We read both so prerequisite info survives into the next cycle's
    task selection — this is what lets a bot ladder DOWN to a reachable subgoal
    instead of re-proposing the blocked end goal."""
    found = {}
    # 1) structured: skill returned the craftItem result verbatim
    res = run.get("result")
    if isinstance(res, dict):
        for m in (res.get("missing") or []):
            if isinstance(m, dict) and m.get("name"):
                found[m["name"]] = max(found.get(m["name"], 0), int(m.get("count", 1)))
    # 2) textual: parse "missing: 3 cobbled_deepslate, 2 stick" out of logs/reason
    text = " ".join(run.get("logs") or [])
    if isinstance(res, dict) and res.get("reason"):
        text += " " + str(res["reason"])
    for chunk in _re.findall(r"missing:\s*([^.]+)", text):
        for m in _re.finditer(r"(\d+)\s+([a-z_]+)", chunk):
            cnt, nm = int(m.group(1)), m.group(2)
            found[nm] = max(found.get(nm, 0), cnt)
    return [{"name": n, "count": c} for n, c in found.items()]

# Failures that are about the WORLD, not the code: no target block nearby, missing
# materials, a transient timeout while searching. Revising the skill's code can't
# fix these — the code is fine, the environment just didn't cooperate. We must NOT
# let these trigger a revision (that corrupts a working skill, as with mine_coal
# failing only because no coal was in range).
_ENV_FAIL_MARKERS = (
    "none found", "no coal found", "not found", "none in range", "out of range",
    "no logs of any species", "missing:", "cannot craft", "no recipe available",
    "goal was changed", "path was stopped", "took to long", "took too long",
    "timed out",
    # mining/terrain world-failures: no reachable stone is a PROPERTY OF THE MAP,
    # not a code defect. Rewriting the mining skill can't put stone under the bot.
    # These markers stop the 15-versions-of-mine_cobblestone thrash at its source.
    "no mineable stone", "no stone reachable", "no stone within range",
    "no exposed stone", "travel to fresh terrain", "need to travel",
    "no stone here", "all buried", "dig-down found no stone",
    # quantity-mismatch / partial-progress verdicts: these describe a WORLD or
    # criterion mismatch, not a code defect. A skill that mined 7 when 5 was asked,
    # or gathered 3 of 10, has WORKING code — rewriting it is what spawned the many
    # duplicate variants seen in log analysis. Never let these revise a skill.
    "instead of the required", "only collected", "only mined", "only placed",
    "less than the required", "increased by 7 instead", "more than",
    "did not increase by", "count did not increase by", "instead of oak",
    "instead of the specified", "fell short",
    # partial-build / placement-coordinate mismatches: placing 7 of 9 planks, or a
    # chest one block off the target, is PROGRESS, not a code defect. These wrongly
    # flagged build_temporary_shelter as broken and blocked build_structure. A
    # partial build should let the NEXT cycle continue, not trigger a rewrite.
    "instead of the required 9", "out of 9", "only placed 1", "only 2 out of",
    "placed 3 out of", "instead of the target coordinates", "directional",
    "1/9", "2/9", "3/9", "instead of 9", "one block off",
)

def is_environmental_failure(run, verdict):
    """True if this failure is about the world (no target/materials/transient),
    not a defect in the skill's code. Such failures should not count toward
    revising the skill.

    Authoritative signal FIRST: helpers now stamp `env_failure:true` on results
    that are world-caused (missing materials, no block in range, transient path
    interruption). We trust that flag when present, so the SAME failure isn't
    classified two different ways depending on the critic's wording. We fall back
    to text markers only when no structured flag is available."""
    # Top-level flag (e.g. the host's water gate sets data.env_failure directly
    # with result=null) takes precedence — it's an explicit "this was the world,
    # not the code" signal from the host.
    if "env_failure" in run:
        return bool(run["env_failure"])
    res = run.get("result")
    if isinstance(res, dict) and "env_failure" in res:
        return bool(res["env_failure"])
    blob = " ".join(run.get("logs") or [])
    if isinstance(res, dict) and res.get("reason"):
        blob += " " + str(res["reason"])
    if run.get("error"):
        blob += " " + str(run["error"])
    blob += " " + str(verdict.get("reason", ""))
    blob = blob.lower()
    return any(mark in blob for mark in _ENV_FAIL_MARKERS)

# Items worth watching at a glance during the early game. Order = display order.
_WATCH_ITEMS = [
    "oak_log", "birch_log", "spruce_log", "_log",   # any wood (last is a catch-all)
    "_planks", "stick",
    "cobblestone", "cobbled_deepslate", "stone",
    "coal", "iron_ingot", "raw_iron",
    "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe",
    "crafting_table", "furnace", "chest", "torch",
]

def state_summary(state):
    """One readable line of the bot's actual world-state: Y-level, position, the
    key inventory counts, and mobility. This is the 'eyes on the world' line — it
    turns the invisible before/after snapshots the critic sees into something a
    human can scan each cycle to answer 'do they ever get cobblestone / what Y are
    they at / are they stuck'."""
    if not state or not state.get("ready", True):
        return "state: (bot not ready)"
    pos = state.get("position") or {}
    x, y, z = pos.get("x", "?"), pos.get("y", "?"), pos.get("z", "?")
    inv = state.get("inventory", {}) or {}
    # collapse the generic "_log" catch-all: show specific logs, and any others once
    shown = set()
    parts = []
    for key in _WATCH_ITEMS:
        if key == "_log":
            # catch any log species not already shown (e.g. cherry/jungle)
            for name, cnt in inv.items():
                if name.endswith("_log") and name not in shown and cnt:
                    parts.append(f"{name}×{cnt}"); shown.add(name)
            continue
        if key == "_planks":
            for name, cnt in inv.items():
                if name.endswith("_planks") and name not in shown and cnt:
                    parts.append(f"{name}×{cnt}"); shown.add(name)
            continue
        # exact-ish match: sum any inventory key containing this token
        cnt = sum(v for k, v in inv.items() if k == key)
        if cnt:
            parts.append(f"{key}×{cnt}"); shown.add(key)
    inv_str = " ".join(parts) if parts else "(empty)"
    mob = state.get("mobility") or {}
    if mob.get("likelyStuckInHole"):
        mob_str = "STUCK-in-hole"
    elif mob.get("surroundedAtFeet", 0) >= 3:
        mob_str = f"boxed({mob.get('surroundedAtFeet')})"
    else:
        mob_str = "ok"
    hp = state.get("health", "?"); food = state.get("food", "?")
    return (f"state: Y={y} pos=({x},{y},{z}) hp={hp} food={food} "
            f"mob={mob_str} | inv: {inv_str}")

def make_logger(username):
    path = os.path.join(LOG_DIR, f"{username}.log")
    # pad names so columns line up when two bots interleave on the console
    tag = f"{username:<8}"
    def logline(msg):
        stamp = time.strftime('%H:%M:%S')
        # console line INCLUDES the bot name so interleaved threads are readable
        # and never misattributed; file keeps the plain line (file is per-bot).
        print(f"{stamp} [{tag}] {msg}", flush=True)
        with open(path, "a") as f:
            f.write(f"{stamp} {msg}\n")
    return logline

# --- persistent-design helpers (the multi-cycle build coherence fix) ----------

_PURPOSE_HINTS = [
    (("wall", "fence", "perimeter", "gate"), "wall"),
    (("shelter", "house", "hut", "home", "cabin", "shack"), "shelter"),
    (("storage", "chest", "barrel", "store"), "storage"),
    (("path", "road", "walkway", "bridge"), "path"),
    (("light", "torch", "lamp", "lantern"), "lighting"),
    (("decor", "garden", "beautif", "facade", "ornament", "flower"), "decoration"),
]

def _build_purpose_hint(task):
    t = (task or "").lower()
    for words, hint in _PURPOSE_HINTS:
        if any(w in t for w in words):
            return hint
    return "structure"

def _design_anchor(state):
    """A (hint_text, origin_dict|None) for where a new design should sit, so builders
    anchor to the settlement rather than wherever each happens to stand."""
    ws = structures.get_workshop()
    if ws:
        return (f"anchor near the community workshop at {ws['x']},{ws['y']},{ws['z']} "
                f"so it becomes part of the settlement, not off on its own.",
                {"x": ws["x"], "y": ws["y"], "z": ws["z"]})
    pos = (state or {}).get("position") or {}
    if "x" in pos:
        return (f"no workshop is sited yet; anchor on flat open ground near your "
                f"position ({pos.get('x')},{pos.get('y')},{pos.get('z')}).",
                {"x": pos.get("x"), "y": pos.get("y"), "z": pos.get("z")})
    return ("anchor on flat open ground near where the group is working.", None)

def _run_verify(bridge, cells, block, log):
    """Ground-truth which design cells exist in the world via helpers.verifyCells
    (a fast, read-only skill). Returns (present_count, missing_cells) or (None,None)
    if verification couldn't run."""
    if not cells:
        return None, None
    coords = [{"x": c["x"], "y": c["y"], "z": c["z"]} for c in cells
              if isinstance(c, dict) and "x" in c and "y" in c and "z" in c]
    if not coords:
        return None, None
    snippet = ("const CELLS = " + json.dumps(coords) + ";\n"
               "return await helpers.verifyCells(CELLS, " + json.dumps(block) + ");")
    try:
        r = bridge.run_skill(snippet, 30000)   # block-reads only; no pathing
        res = (r.get("result") or {})
        if res.get("ok"):
            return int(res.get("present", 0)), list(res.get("missing", []))
    except Exception as e:
        log(f"  design verify error: {e}")
    return None, None

def _prepare_design(bridge, bot_cfg, log, plan, task, state):
    """Ensure a persistent design exists for this build task and is verified against
    the world. Returns a design dict with `to_build` = still-missing cells, or None
    to fall back to the normal (design-less) build flow — so this is purely additive
    and never blocks a build."""
    username = bot_cfg["username"]
    design = None
    did = plan.get("design_id")
    if did and str(did).lower() not in ("null", "none", ""):
        design = structures.get_design(str(did))
    if design is None:
        design = structures.active_design_for(username)   # continue an unfinished one
    # Never treat a 0-cell record as a real design (an old bug could persist one, and
    # an empty cell list reads as "already complete" and would block the build forever).
    if design is not None and design.get("total", 0) < 1:
        design = None

    if design is not None:
        pc, missing = _run_verify(bridge, design.get("cells"), design.get("block"), log)
        if pc is not None:
            structures.update_design_progress(design["id"], pc, missing)
            design = structures.get_design(design["id"]) or design
        # Complete ONLY if it actually has cells and none remain missing.
        if design.get("status") == "complete" or (
                design.get("total", 0) > 0 and not design.get("missing")):
            log(f"  design '{design['id']}' already complete "
                f"({design.get('present')}/{design.get('total')}) — nothing to build")
            return None
    else:
        # author a NEW design (the LLM decides the full shape; we persist + verify)
        hint_text, origin = _design_anchor(state)
        purpose_hint = _build_purpose_hint(task)
        try:
            out = llm.extract_json(llm.actor(prompts.design_prompt(
                task, purpose_hint, state,
                build_rules=structures.build_mechanics_block(),
                anchor_hint=hint_text, lessons=lessons.lessons_block()),
                label="design"))   # thinking driven by llm.THINKING_LABELS (off today)
        except Exception as e:
            log(f"  design authoring failed ({e}) — falling back to normal build")
            return None
        cells = out.get("cells") if isinstance(out, dict) else None
        if not cells:
            log("  design author returned no cells — falling back to normal build")
            return None
        design = structures.save_design(
            username, (out.get("name") or task[:40]),
            (out.get("purpose") or purpose_hint),
            (out.get("block") or "cobblestone"), cells,
            origin=origin if isinstance(origin, dict) else None)
        # save_design returns None if NONE of the cells were valid {x,y,z} (e.g. the
        # model omitted Y). Don't persist junk — just build normally this cycle.
        if design is None:
            log("  design had no valid cells (missing coords) — falling back to normal build")
            return None
        log(f"  🧱 authored design '{design['id']}' ({design['total']} cells, "
            f"{design['block']}) — {str(out.get('review',''))[:150]}")
        post_note(username, f"Designed {design['name']} ({design['purpose']}, "
                            f"{design['total']} blocks)")
        pc, missing = _run_verify(bridge, design["cells"], design["block"], log)
        if pc is not None:
            structures.update_design_progress(design["id"], pc, missing)
            design = structures.get_design(design["id"]) or design

    design = dict(design)
    design["to_build"] = design.get("missing") or design.get("cells")
    return design

def _reverify_design(bridge, design_for_code, username, log):
    """After a build attempt, re-check the design against the world and update its
    progress + the in-memory `to_build` handed to the next attempt. Marks a linked
    plan slot built and posts a note when the structure is complete."""
    if not design_for_code:
        return
    cur = structures.get_design(design_for_code["id"]) or design_for_code
    pc, missing = _run_verify(bridge, cur.get("cells"), cur.get("block"), log)
    if pc is None:
        return
    updated = structures.update_design_progress(design_for_code["id"], pc, missing)
    if not updated:
        return
    design_for_code["missing"] = updated.get("missing")
    design_for_code["to_build"] = updated.get("missing") or []
    design_for_code["present"] = updated.get("present")
    done = updated.get("status") == "complete"
    log(f"  🧱 design '{design_for_code['id']}' progress: "
        f"{updated.get('present')}/{updated.get('total')} placed"
        + ("  ✅ COMPLETE" if done else ""))
    if done:
        slot = updated.get("plan_slot")
        if slot:
            try:
                structures.complete_slot(str(slot), username)
            except Exception:
                pass
        post_note(username, f"Completed structure: {updated.get('name')} "
                            f"({updated.get('present')} blocks)")


def _programmatic_verdict(run, delta_nonzero, design_progressed):
    """A fast, LLM-FREE success judgement for cases where we have a grounded signal:
    a reused PROVEN skill, or a persistent-design build (verified against the world).
    This replaces a ~40s critic call on the bulk of routine/continuing work — the
    biggest single source of bots standing idle. It is deliberately conservative:
    a runtime error or an explicit failure status is a fail; real, measured progress
    (design cells placed, inventory/world changed, a success status) is a pass; a
    clean run with NO measurable effect is a fail (so nothing is credited for nothing)."""
    err = run.get("error")
    if err:
        return {"success": False, "confidence": 0.9,
                "reason": f"runtime error: {str(err)[:80]}", "_programmatic": True}
    res = run.get("result")
    if isinstance(res, dict) and res.get("error"):
        return {"success": False, "confidence": 0.85,
                "reason": f"skill reported: {str(res.get('error'))[:80]}", "_programmatic": True}
    st = str(res.get("status", "")).lower() if isinstance(res, dict) else ""
    if st in ("blocked", "no_progress", "failed", "fail", "timeout", "error", "stuck"):
        return {"success": False, "confidence": 0.8,
                "reason": f"skill status={st}", "_programmatic": True}
    if design_progressed:
        return {"success": True, "confidence": 0.8,
                "reason": "design cells placed (verified in world)", "_programmatic": True}
    if st in ("built", "ok", "done", "placed", "crafted", "complete", "completed",
              "deposited", "success", "collected", "gathered"):
        return {"success": True, "confidence": 0.8,
                "reason": f"skill status={st}", "_programmatic": True}
    if delta_nonzero:
        return {"success": True, "confidence": 0.7,
                "reason": "inventory/world changed, no error", "_programmatic": True}
    return {"success": False, "confidence": 0.6,
            "reason": "ran clean but no measurable progress", "_programmatic": True}


# How many cycles in a row a bot may CONTINUE the same design build without a fresh
# propose call. High enough to skip most redundant planning on a multi-cycle build,
# low enough that survival/community needs still get re-evaluated periodically.
CONT_MAX_CYCLES = 6


def run_cycle(bridge, bot_cfg, log, recent, recent_failures, blocked_prereqs,
              continuation=None):
    purpose = bot_cfg["purpose"]; username = bot_cfg["username"]
    state = bridge.get_state()
    if not state.get("ready"):
        log("bot not connected (reconnecting?) — waiting 10s before next cycle")
        time.sleep(10); return None

    # RECOVERY: if the bot is physically stuck, get it unstuck with the tested
    # escapeHole helper BEFORE spending an LLM cycle deciding to escape. This stops
    # the "whole run trapped in a hole" failure mode.
    mob = state.get("mobility") or {}
    if mob.get("likelyStuckInHole") or mob.get("surroundedAtFeet", 0) >= 3:
        log("stuck at cycle start — running getUnstuck() recovery")
        try:
            r = bridge.run_skill("return await helpers.getUnstuck();",
                                 config.SKILL_TIMEOUT_MS)
            res = r.get("result") or {}
            log(f"  unstuck result: {res}")
            state = bridge.get_state()   # refresh after escaping
        except Exception as e:
            log(f"  unstuck recovery error: {e}")

    # EYES ON THE WORLD: one readable line of where the bot is and what it holds,
    # so runs can be diagnosed at a glance instead of inferred from critic prose.
    log(state_summary(state))

    bb = read_blackboard()

    # keep the shared community-infrastructure registry grounded in reality:
    # register any shared structures this bot can actually see right now.
    structures.sync_from_scan(state.get("structuresNearby"), by=username)
    pos = state.get("position") or {}
    reg = structures.registry_block(
        near=(pos.get("x", 0), pos.get("y", 0), pos.get("z", 0)))

    # WORKSHOP: is this bot the decider? Build the workshop-status block (which
    # escalates an unmet need when shown to the decider). Age the need once per
    # decider cycle so pressure rises with time even without a fresh request.
    is_decider = bool(bot_cfg.get("workshop_decider"))
    near_xyz = (pos.get("x", 0), pos.get("y", 0), pos.get("z", 0))
    if is_decider:
        structures.bump_workshop_need()
    ws_block = structures.workshop_block(is_decider=is_decider, near=near_xyz)

    # FLOATERS ("good citizens" with no fixed role) get a focused view of unmet
    # community needs so they can self-assign the most useful job; specialists don't.
    is_floater = bool(bot_cfg.get("floater"))
    community_needs = (structures.community_needs_block(bb.get("notes"))
                       if is_floater else "")
    # Any bot's unfinished persistent structure designs, so a builder continues one
    # instead of starting over (empty text for bots that have none).
    designs_txt = structures.designs_block(username)

    # TEXT-LEVEL LOOP DETECTION: catch stuck loops the capability classifier
    # misses (monotonic radius/coord drift, and verbatim repeats that never hit
    # the give-up streak). Operates on the raw task strings of recent cycles.
    recent_task_strs = [o.get("task") for o in recent if o and o.get("task")]
    stuck_block = stuckloop.block(recent_task_strs)
    if stuck_block:
        d = stuckloop.detect(recent_task_strs)
        log(f"  🔁 stuck-loop detected ({d['kind']}, ×{d['count']}: "
            f"\"{d['shape'][:60]}\") — injecting pattern-break directive")
        # If the loop is a failed-to-REACH loop, pre-empt with a real unstuck this
        # cycle so the directive has a physically different world to act in.
        if d["kind"] and any(w in d["shape"] for w in
                             ("return surface", "position", "navigate", "reach",
                              "go ", "travel", "move ")):
            try:
                r = bridge.run_skill("return await helpers.getUnstuck();",
                                     config.SKILL_TIMEOUT_MS)
                log(f"  ↳ pre-emptive getUnstuck: {(r.get('result') or {})}")
                state = bridge.get_state()
            except Exception as e:
                log(f"  ↳ pre-emptive getUnstuck error: {e}")

    # ---- CONTINUATION (#2): skip the propose LLM call when there is obvious
    # unfinished work to carry straight on with — specifically a build design still
    # missing cells that we made progress on last cycle. A multi-cycle build used to
    # spend a propose (+ a critic) call EVERY cycle re-deciding to keep building the
    # same thing; those calls are pure idle time. Bounded two ways so a bot never gets
    # trapped: we stop after CONT_MAX_CYCLES in a row (so survival/community needs get
    # re-evaluated), and any cycle that fails to progress clears the continuation (so a
    # stuck build drops back to a fresh propose that can gather, relocate, or abandon).
    # Skipped while stuck-looping, so the pattern-break path above still runs.
    plan = None
    cont = continuation if isinstance(continuation, dict) else None
    if cont and cont.get("kind") == "design" and not stuck_block \
            and cont.get("n", 0) < CONT_MAX_CYCLES:
        _d = structures.get_design(cont.get("id"))
        if _d and _d.get("status") != "complete" and _d.get("missing"):
            plan = {"task": f"continue building {_d['name']}",
                    "build_intent": True, "design_id": _d["id"],
                    "success_looks_like": (f"more of {_d['name']} ({_d['purpose']}) is "
                        f"built — place its remaining {len(_d['missing'])} block(s)")}
            log(f"  ⏩ continuing design '{_d['id']}' "
                f"({_d.get('present')}/{_d.get('total')} placed, "
                f"streak {cont.get('n',0)+1}/{CONT_MAX_CYCLES}) — no propose call")

    if plan is None:
        plan_raw = llm.actor(prompts.propose_prompt(
            purpose, state, skills.manifest_summary(), bb, recent[-4:],
            recent_failures=recent_failures, lessons=lessons.lessons_block(),
            goal=bot_cfg.get("goal", "(no specific long-term goal)"),
            progress=goals.progress_block(username),
            community_structures=reg,
            blocked_prereqs=blocked_prereqs,
            broken_capabilities=capabilities.broken_block(),
            stuck_loop=stuck_block,
            workshop=ws_block, is_decider=is_decider,
            plan=structures.plan_block(username),
            structure_purpose=structures.purpose_block(),
            community_needs=community_needs, designs=designs_txt),
            label="strategy")   # thinking driven by llm.THINKING_LABELS (off today)
        try: plan = llm.extract_json(plan_raw)
        except Exception as e:
            # Truncation-safe retry: a reasoning trace that ran long can eat the token
            # budget before the JSON answer finishes, producing unparseable/empty output.
            # Retry ONCE with reasoning OFF — a non-reasoning call spends its whole budget
            # on the answer, so the JSON always completes. This rescues the cycle instead
            # of wasting it on a truncated strategy call.
            log(f"propose parse failed (retrying without reasoning): {e}")
            try:
                plan_raw = llm.actor(prompts.propose_prompt(
                    purpose, state, skills.manifest_summary(), bb, recent[-4:],
                    recent_failures=recent_failures, lessons=lessons.lessons_block(),
                    goal=bot_cfg.get("goal", "(no specific long-term goal)"),
                    progress=goals.progress_block(username),
                    community_structures=reg,
                    blocked_prereqs=blocked_prereqs,
                    broken_capabilities=capabilities.broken_block(),
                    stuck_loop=stuck_block,
                    workshop=ws_block, is_decider=is_decider,
                    plan=structures.plan_block(username),
                    structure_purpose=structures.purpose_block(),
                    community_needs=community_needs, designs=designs_txt),
                    think=False, label="strategy-retry")
                plan = llm.extract_json(plan_raw)
            except Exception as e2:
                log(f"propose parse failed again (no-reasoning retry): {e2}; raw={str(plan_raw)[:200]}")
                return {"task": None, "outcome": "propose_parse_fail"}
        if not isinstance(plan, dict) or not plan.get("task"):
            log(f"propose returned no task (likely truncated reasoning); raw={str(plan)[:150]}")
            return {"task": None, "outcome": "propose_no_task"}
    task = plan["task"]
    success_looks_like = plan.get("success_looks_like", "task completed")
    reuse = plan.get("reuse_skill")
    # Situational self-check: surface the agent's own read of whether it's serving
    # its purpose vs. just collecting. If it chose something off-purpose (e.g.
    # settling underground) it must justify that to the community — post it.
    assessment = (plan.get("situation_assessment") or "").strip()
    if assessment:
        log(f"  self-check: {assessment[:160]}")
    situation_note = (plan.get("situation_note") or "").strip()
    if situation_note and situation_note.lower() not in ("null", "none", ""):
        post_note(username, f"[purpose] {situation_note}")
        log(f"  ↳ posted purpose-justification to blackboard")
    log(f"TASK: {task}  (reuse={reuse})")

    # Village-plan coordination: the decider may propose a shared layout; any agent
    # may claim an open slot before building it. This is the shared artifact that
    # keeps the settlement coherent instead of two agents building at random.
    plan_action = plan.get("plan_action") if isinstance(plan.get("plan_action"), dict) else None
    if plan_action:
        try:
            if "propose" in plan_action and is_decider:
                origin = structures.get_workshop() or state.get("pos")
                p = structures.set_plan(username, origin, plan_action["propose"])
                log(f"  🏛 {username} proposed a village plan ({len(p['slots'])} sites)")
                post_note(username, f"[plan] proposed a village layout: "
                          + ", ".join(s["name"] for s in p["slots"]))
            elif "propose" in plan_action and not is_decider:
                log(f"  (ignored plan proposal — {username} is not the decider)")
            if "claim" in plan_action:
                s = structures.claim_slot(str(plan_action["claim"]), username)
                if s:
                    log(f"  📌 {username} claimed plan slot '{s['id']}' ({s['status']})")
            if "complete" in plan_action:
                s = structures.complete_slot(str(plan_action["complete"]), username)
                if s:
                    log(f"  ✅ {username} marked plan slot '{s['id']}' BUILT")
                    post_note(username, f"[plan] finished {s['name']}")
        except Exception as e:
            log(f"  plan_action error: {e}")

    # BUILD DESIGN: if this task builds/extends a structure, ensure a persistent
    # LLM-authored design exists and is verified against the world, so the build
    # converges on the SAME structure across cycles. Purely additive — a None means
    # fall back to the normal build flow (no regression for non-build tasks or if
    # design authoring fails).
    build_intent = bool(plan.get("build_intent"))
    design_for_code = None
    if build_intent and getattr(config, "ENABLE_PERSISTENT_DESIGNS", True):
        try:
            design_for_code = _prepare_design(bridge, bot_cfg, log, plan, task, state)
        except Exception as e:
            log(f"  design prep error ({e}) — normal build")
        if design_for_code:
            log(f"  build design active: '{design_for_code['id']}' — "
                f"{len(design_for_code.get('to_build') or [])} cells still to place")

    code = None; reused_name = None
    if reuse and reuse != "null":
        code = skills.get_code(reuse)
        if code: reused_name = reuse; log(f"reusing skill '{reuse}'")
    if code is None:
        cands = skills.retrieve(task)
        if cands: log(f"retrieval suggests: {cands}")

    active_skill = reused_name   # the saved skill currently under test (if any)
    revised_this_cycle = False
    attempt_history = []
    cycle_missing = {}           # prerequisites the game said we lacked this task
    cycle_all_env = True         # did EVERY failed attempt fail for world reasons?
    cycle_had_failure = False    # did we record at least one failure to judge?
    for attempt in range(1, config.MAX_RETRIES + 1):
        if code is None or attempt > 1:
            # BUILD MECHANICS go to the CODER. They used to be injected only into
            # the proposer (which writes no code), so the model actually choosing
            # placement coordinates had never been told about groundY, buildBlocks,
            # block physics, or reading placeAt's failure reason. That gap is what
            # produced roofs floating over 2-block walls and 95 placements driven
            # into solid dirt.
            code = llm.extract_code(llm.actor(prompts.code_prompt(
                task, success_looks_like, state,
                attempt_history=attempt_history, total_attempts=attempt,
                lessons=lessons.lessons_block(),
                build_rules=structures.build_mechanics_block(),
                design=design_for_code), label="code-gen"))
            reused_name = None   # freshly written this attempt
        log(f"attempt {attempt}: executing ({len(code)} chars)")
        # Make the community workshop site available to skill code as `WORKSHOP`
        # (coords object or null) and whether this bot may found it as `IS_DECIDER`.
        # Skills place shared infra via helpers.placeAtWorkshop(name, WORKSHOP).
        ws = structures.get_workshop()
        preamble = (
            f"const WORKSHOP = {json.dumps(ws) if ws else 'null'};\n"
            f"const IS_DECIDER = {'true' if is_decider else 'false'};\n")
        # Also push the same context OUT-OF-BAND so tested helpers (craftItem) can
        # route shared infra to home, not just skill code via the WORKSHOP const.
        run = bridge.run_skill(preamble + code, config.SKILL_TIMEOUT_MS,
                               context={"workshop": ws, "isDecider": is_decider})
        if run.get("error"): log(f"  runtime error: {run['error']}")
        # INVENTORY DELTA: did this attempt actually change what the bot holds?
        # Directly answers "did mining ever yield cobblestone" instead of guessing.
        delta_nonzero = False
        try:
            _b = (run.get("before") or {}).get("inventory", {}) or {}
            _a = (run.get("after") or {}).get("inventory", {}) or {}
            _keys = set(_b) | set(_a)
            _delta = {k: _a.get(k, 0) - _b.get(k, 0) for k in _keys
                      if _a.get(k, 0) - _b.get(k, 0) != 0}
            delta_nonzero = bool(_delta)
            if _delta:
                _ds = " ".join(f"{k}{'+' if v>0 else ''}{v}" for k, v in sorted(_delta.items()))
                log(f"  Δinv: {_ds}")
            else:
                log(f"  Δinv: (no change)")
        except Exception:
            pass
        # DESIGN PROGRESS: re-check the persistent design against the world so the
        # next attempt gets only the still-missing cells, and a completed structure
        # marks its plan slot built. Grounded in reality (verifyCells), not claims.
        design_progressed = False
        if design_for_code:
            _prev_present = design_for_code.get("present", 0)
            try:
                _reverify_design(bridge, design_for_code, username, log)
            except Exception as e:
                log(f"  design reverify error: {e}")
            design_progressed = design_for_code.get("present", 0) > _prev_present
        # WORKSHOP side effects reported factually by the skill (independent of the
        # task verdict): a decider establishing the site, infra placed at it, or a
        # non-decider signalling that a workshop is needed.
        _res = run.get("result")
        if isinstance(_res, dict):
            if _res.get("tool_blocked"):
                log("  ⛏ tool-blocked: no reachable stone this tool can mine "
                    "(may relocate via findMineableStone next)")
            if _res.get("movedTo"):
                mt = _res["movedTo"]
                log(f"  → relocated to exposed stone at {mt.get('x')},{mt.get('y')},{mt.get('z')}")
            est = _res.get("establish_workshop") or _res.get("workshop_site")
            if est and is_decider and isinstance(est, dict) and "x" in est:
                ws = structures.establish_workshop(est["x"], est["y"], est["z"], by=username)
                log(f"  🏛  workshop established at {ws['x']},{ws['y']},{ws['z']} by {username}")
                post_note(username, f"Sited the community workshop at "
                                    f"{ws['x']},{ws['y']},{ws['z']} — build shared infra here")
            placed = _res.get("placed_at_workshop")
            if placed:
                structures.add_workshop_contents(placed if isinstance(placed, str) else _res.get("crafted", "structure"))
            if _res.get("noWorkshop") or _res.get("need_workshop"):
                structures.signal_workshop_need(by=username)
                log(f"  📣 {username} signalled a workshop is needed")
        # VERDICT. Skip the slow (~40s) LLM critic when we already have a GROUNDED
        # success signal and don't need the critic's promotion-gating role:
        #   - a persistent-design build (verified against the world by verifyCells), or
        #   - a reused PROVEN skill (solid track record — see skills.is_proven).
        # This is the main lever against bots standing idle: the LLM critic runs only
        # for NEW/unproven code, which is exactly where its judgement is needed.
        if bool(design_for_code) or (active_skill and skills.is_proven(active_skill)):
            verdict = _programmatic_verdict(run, delta_nonzero, design_progressed)
            log(f"  ⚡ fast verdict (no LLM critic): success={verdict['success']} "
                f"— {verdict.get('reason','')}")
        else:
            # The critic's verdict is what marks a plan slot BUILT. Give it the STRUCTURE
            # GOALS (what a shelter/wall is FOR) so it grades against purpose instead of
            # "some blocks moved" — otherwise a roofless wall passes and the bot moves on.
            # NOTE: the SHORT form. The critic runs on the small model with a small
            # context window; sending the full purpose_block() overran it and every judge
            # call came back 400 Bad Request.
            _goals = structures.critic_goals_block()
            try:
                verdict = llm.extract_json(llm.critic(
                    prompts.critic_prompt(task, success_looks_like, run,
                                          structure_goals=_goals)))
            except Exception:
                # Critic returned non-JSON (Gemma sometimes emits markdown). Retry once
                # with an explicit correction, then FAIL-SAFE to not-success — never
                # treat an unparseable verdict as success (that promotes broken skills).
                try:
                    verdict = llm.extract_json(llm.critic(
                        prompts.critic_prompt(task, success_looks_like, run,
                                              structure_goals=_goals)
                        + [{"role": "user", "content":
                            "Your last reply was not valid JSON. Reply with ONLY the JSON "
                            "object: {\"success\": true|false, \"confidence\": 0-1, "
                            "\"reason\": \"...\"} and nothing else."}]))
                except Exception as e:
                    verdict = {"success": False, "confidence": 0.2,
                               "reason": f"critic could not be parsed twice: {e}"}
        # Normalize: the parsed JSON might be valid but missing/renaming keys.
        # Coerce to a safe shape so nothing downstream can KeyError.
        if not isinstance(verdict, dict):
            verdict = {"success": False, "confidence": 0.2, "reason": "non-dict verdict"}
        raw_success = verdict.get("success", verdict.get("passed", verdict.get("result")))
        if isinstance(raw_success, str):
            raw_success = raw_success.strip().lower() in ("true", "yes", "pass", "passed", "success")
        verdict["success"] = bool(raw_success)
        verdict.setdefault("confidence", 0.5)
        verdict.setdefault("reason", "(no reason given)")
        log(f"  critic: success={verdict['success']} conf={verdict.get('confidence')} "
            f"— {str(verdict.get('reason',''))[:120]}")

        if verdict["success"]:
            if active_skill:
                skills.record_use(active_skill, True)
                tag = "revised skill" if revised_this_cycle else "reused skill"
                log(f"  {tag} '{active_skill}' worked")
            elif (not verdict.get("_programmatic")
                  and verdict.get("confidence", 0) >= config.CONFIDENCE_TO_PROMOTE):
                try:
                    ident = llm.extract_json(llm.actor(prompts.name_prompt(task, code), label="naming"))
                    slug, created = skills.promote(ident["name"], ident["description"],
                                          ident.get("keywords", []), code)
                    if created:
                        log(f"  promoted new skill '{slug}'")
                        post_note(username, f"Learned to: {ident['description']}")
                    else:
                        # behavior already known — reused the shared skill, no new file
                        log(f"  reused existing skill '{slug}' for this behavior "
                            f"(no duplicate created)")
                except Exception as e:
                    log(f"  promote failed: {e}")
            post_note(username, f"Did: {task}")
            goals.record_step(username, task)   # log progress toward long-term goal
            capabilities.record(task, True)     # this capability works right now
            blocked_prereqs.clear()   # made progress; drop any stale prereq block
            # CONTINUATION: if this was a design build that progressed but isn't done,
            # tell the next cycle to carry straight on with it (no propose call). The
            # streak counter (n) enforces CONT_MAX_CYCLES so it can't monopolise forever.
            next_cont = None
            if design_for_code and design_for_code.get("missing"):
                _same = bool(cont and cont.get("id") == design_for_code["id"])
                next_cont = {"kind": "design", "id": design_for_code["id"],
                             "n": (cont.get("n", 0) + 1) if _same else 1}
            return {"task": task, "outcome": "success", "attempts": attempt,
                    "continuation": next_cont}

        # ---- failure bookkeeping ----
        logs = run.get("logs") or []
        attempt_history.append({
            "attempt": attempt,
            "code": code,
            "error": run.get("error"),
            "stack": run.get("stack"),
            "logs": " | ".join(logs)[:500] if logs else "",
            "critic_reason": verdict.get("reason"),
        })
        # remember any prerequisites the game told us we lacked this attempt
        for m in extract_missing(run):
            cycle_missing[m["name"]] = max(cycle_missing.get(m["name"], 0), m["count"])

        # Classify THIS failure as world-caused or code-caused, for every attempt
        # (not only saved-skill runs). If any attempt was a genuine code/logic
        # failure we still want a lesson; but if the whole cycle failed purely
        # because the world didn't cooperate (no reachable stone, transient path
        # interruption), writing a "lesson" only manufactures a false rule that
        # misdirects future generation for ALL bots. Track that here.
        cycle_had_failure = True
        if not is_environmental_failure(run, verdict):
            cycle_all_env = False

        # If a SAVED skill just failed, decide whether the failure is the SKILL's
        # fault (code defect -> maybe revise) or the WORLD's (no target/materials/
        # transient -> the code is fine, don't touch it).
        if active_skill:
            env_fail = is_environmental_failure(run, verdict)
            if env_fail:
                # count it as a use-with-no-progress but NOT a code failure, so a
                # good skill isn't revised just because coal wasn't nearby.
                log(f"  skill '{active_skill}' failed for environmental reasons "
                    f"(no target/materials/transient) — not counting against it")
            else:
                health = skills.record_use(active_skill, False)
                # RETIREMENT CEILING: a skill that has been rewritten many times and
                # still fails is not going to be fixed by another rewrite — the flaw
                # is usually below it (a helper) or the task is wrong. Retire it so it
                # stops being suggested and endlessly re-revised (the 67x
                # mine_cobblestone churn). A fresh skill can still be promoted later.
                if (health and health.get("revisions", 0) >= config.MAX_SKILL_REVISIONS):
                    skills.retire(active_skill)
                    log(f"  🗑 retired '{active_skill}' after "
                        f"{health.get('revisions')} revisions still failing — "
                        f"will not suggest it again")
                    active_skill = None
                elif (not revised_this_cycle and health
                        and skills.needs_revision(active_skill)):
                    log(f"  skill '{active_skill}' is unreliable "
                        f"({health.get('uses',0)} ok/{health.get('fails',0)} fail) — revising")
                    try:
                        old_code = skills.get_code(active_skill) or code
                        desc = skills.list_skills().get(active_skill, {}).get("description", "")
                        new_code = llm.extract_code(llm.actor(prompts.revise_skill_prompt(
                            active_skill, desc, old_code, task, attempt_history,
                            lessons=lessons.lessons_block()), label="revise-code"))
                        skills.revise(active_skill, new_code,
                                      note=str(verdict.get("reason", ""))[:120])
                        revised_this_cycle = True
                        code = new_code            # try the revised version next loop
                        post_note(username, f"Revised skill '{active_skill}'")
                        log(f"  installed revision of '{active_skill}', retrying it")
                        time.sleep(config.PAUSE_BETWEEN)
                        continue                   # skip fresh-code generation; test revision
                    except Exception as e:
                        log(f"  revision failed: {e}")
            active_skill = None   # stop attributing further attempts to the skill
        time.sleep(config.PAUSE_BETWEEN)

    log(f"  gave up on task after {config.MAX_RETRIES} attempts")
    post_note(username, f"Struggled with: {task}")
    # remember it so the proposer avoids re-suggesting it next cycle
    last_reason = attempt_history[-1]["critic_reason"] if attempt_history else "unknown"
    # Only count this against the capability when at least one attempt was a genuine
    # code/logic failure. A purely ENVIRONMENTAL wipe — drowning, path interrupted,
    # a crowded/unreachable crafting table, no reachable materials — must NOT block
    # the capability. Blocking on transient world conditions amputated the society's
    # own action space over time (393 capabilities BLOCKED in one 20-bot run, most of
    # them from water/path/congestion), which is a major reason no community formed:
    # bots progressively lost the ability to mine, craft, and build. Environmental
    # give-ups are a wash — the world didn't cooperate this cycle, the code is fine.
    if not cycle_all_env:
        cap = capabilities.record(task, False, reason=str(last_reason))
        if capabilities.is_broken(cap):
            log(f"  ⚠ capability '{cap}' is now BLOCKED (repeated failures) — "
                f"proposer will route around it next cycle")
    else:
        log("  ↩ capability NOT penalized — failure was environmental (transient "
            "world conditions), not a code defect")
    recent_failures.append(f"{task} (reason: {str(last_reason)[:80]})")
    del recent_failures[:-6]  # keep only the last 6
    # PREREQUISITE LADDERING: if the game told us WHICH materials were missing,
    # record them so next cycle's proposer targets the missing prerequisite
    # instead of re-proposing the same blocked end goal. This is the fix for
    # "burn 4 attempts discovering the tech-tree chain one failed craft at a time."
    if cycle_missing:
        blocked_prereqs.clear()
        blocked_prereqs.append({"blocked_task": task,
                                "missing": [{"name": n, "count": c}
                                            for n, c in cycle_missing.items()]})
        log(f"  blocked on prerequisites: " +
            ", ".join(f"{c} {n}" for n, c in cycle_missing.items()))
    # SELF-IMPROVEMENT: distill a durable, general lesson so this class of mistake
    # is avoided by ALL bots in future — without a human editing any prompt.
    # BUT: never distill a lesson from a purely environmental failure. A world
    # that lacked reachable stone teaches nothing about the CODE; a "lesson" here
    # would be a confabulated rule ("verify tool durability", "ensure pickaxe is
    # equipped") that then poisons every future prompt. Only learn from failures
    # where at least one attempt was a genuine code/logic defect.
    if attempt_history and cycle_had_failure and not cycle_all_env:
        try:
            out = llm.extract_json(llm.actor(prompts.lesson_prompt(task, attempt_history), label="lesson"))
            lesson = str(out.get("lesson", "")).strip()
            if lesson and lesson.upper() != "NONE":
                lessons.add_lesson(lesson, source_task=task)
                log(f"  📚 learned lesson: {lesson}")
                post_note(username, f"Lesson: {lesson}")
        except Exception as e:
            log(f"  lesson distill failed: {e}")
    elif cycle_had_failure and cycle_all_env:
        log("  ↩ no lesson written — failure was environmental "
            "(world lacked reachable materials), not a code defect")
    return {"task": task, "outcome": "gave_up", "continuation": None}

def run_bot(bot_cfg, start_delay=0.0):
    """One bot's full lifecycle: connect, loop, disconnect. Runs in a thread."""
    username = bot_cfg["username"]
    log = make_logger(username)
    # Bind THIS bot's endpoints for THIS thread, so every llm.actor()/llm.critic()
    # call it makes routes to the box its group owns (isolation, per config.py).
    try:
        actor_ep = llm.get_endpoint(bot_cfg.get("actor_endpoint", "actor"))
        critic_ep = llm.get_endpoint(bot_cfg.get("critic_endpoint", "critic"))
        llm.bind_endpoints(actor_ep, critic_ep)
        log(f"[endpoints] actor={bot_cfg.get('actor_endpoint','actor')} "
            f"({actor_ep['url'].split('//')[-1].split('/')[0]}), "
            f"critic={bot_cfg.get('critic_endpoint','critic')} "
            f"({critic_ep['url'].split('//')[-1].split('/')[0]})")
    except Exception as e:
        log(f"FATAL: bad endpoint binding for {username}: {e}")
        return
    if start_delay:
        time.sleep(start_delay)   # stagger so bots on the SAME box don't all fire at once
    log(f"=== starting agent '{username}' ===")
    bridge = BotBridge(mc_host=config.MC_HOST, mc_port=config.MC_PORT,
                       username=username, auth=config.MC_AUTH,
                       version=config.MC_VERSION, on_log=log)
    try:
        bridge.wait_ready(timeout=120)
        recent = []
        recent_failures = []   # rolling memory of tasks this bot gave up on
        blocked_prereqs = []   # structured missing-materials from the last blocked task
        cont = None            # continuation: carry an unfinished build to the next cycle
        for cycle in range(1, config.MAX_CYCLES + 1):
            log(f"\n----- {username} cycle {cycle}/{config.MAX_CYCLES} -----")
            try:
                outcome = run_cycle(bridge, bot_cfg, log, recent,
                                    recent_failures, blocked_prereqs, continuation=cont)
            except Exception as e:
                log(f"cycle error: {e}")
                outcome = {"task": None, "outcome": "cycle_exception"}
                # If the actor LLM endpoint is unreachable (box restarting, model
                # reloading), don't hammer it every PAUSE_BETWEEN seconds — that's
                # what produced the multi-minute Broken-pipe / Connection-refused
                # storms in the logs. Back off so the box has time to come back and
                # the log stays readable. Normal task failures skip this.
                msg = str(e).lower()
                if any(s in msg for s in ("broken pipe", "connection refused",
                                          "max retries exceeded", "failed to establish",
                                          "connection aborted", "bad request")):
                    log("  actor endpoint looks down — backing off 30s before retry")
                    time.sleep(30)
            if outcome:
                recent.append(outcome); recent = recent[-8:]
            cont = (outcome or {}).get("continuation")   # carry-forward build, if any
            # LLM health each cycle — makes retries/timeouts/slow calls visible so
            # you can watch for concurrency pressure as bot count grows.
            log("  " + llm.stats_line())
            log("  " + llm.stats_by_label())
            time.sleep(config.PAUSE_BETWEEN)
        log(f"=== {username} run complete ===")
    except Exception as e:
        log(f"FATAL for {username}: {e}")
    finally:
        bridge.close()

def _uses_only_llamacpp(bot_cfg):
    """True if this bot's actor AND critic run on llama.cpp boxes (the V100 actor +
    Mac critic), i.e. it needs NONE of the vLLM boxes. Server-type based, so it never
    hardcodes an IP and keeps working if you re-address the boxes in local_settings."""
    try:
        a = llm.get_endpoint(bot_cfg.get("actor_endpoint", "actor"))
        c = llm.get_endpoint(bot_cfg.get("critic_endpoint", "critic"))
    except Exception:
        return False
    return a.get("server") != "vllm" and c.get("server") != "vllm"


def main():
    ap = argparse.ArgumentParser(
        description="Run the mc-sid agent society (all bots by default).")
    ap.add_argument("usernames", nargs="*",
                    help="optional: only run these named bots (default: all).")
    ap.add_argument("--debug", action="store_true",
                    help="only run the llama.cpp actor/critic bots (V100 + Mac); skip "
                         "the vLLM boxes so they can be repurposed for local LLM "
                         "coding. Without this flag, ALL bots run.")
    args = ap.parse_args()

    os.makedirs(STATE_DIR, exist_ok=True); os.makedirs(LOG_DIR, exist_ok=True)
    # Route LLM warnings (timeouts, retries, slow calls) to the console so they're
    # visible live across all bot threads, not swallowed silently.
    llm.set_log_hook(lambda m: print(f"        {m}"))
    if not os.path.exists(BLACKBOARD):
        write_blackboard({"notes": [], "structures": [], "needs": []})

    # optional CLI filter: python runner.py Mason Garrick
    wanted = set(args.usernames)
    bots = [b for b in config.BOTS if not wanted or b["username"] in wanted]

    # --debug: drop every bot that needs a vLLM box, leaving only the llama.cpp
    # (actor/critic) bots so the vLLM machines are free. Purely a launch-time filter —
    # no config or code changes, and a normal run (no flag) launches everyone again.
    if args.debug:
        kept = [b for b in bots if _uses_only_llamacpp(b)]
        skipped = [b["username"] for b in bots if b not in kept]
        print(f"[debug] vLLM boxes DISABLED — skipping {len(skipped)} bot(s): {skipped}")
        bots = kept

    if not bots:
        print(f"No matching bots. Available: {[b['username'] for b in config.BOTS]}")
        return

    print(f"launching {len(bots)} bot(s): {[b['username'] for b in bots]}")
    # PER-GROUP stagger: the k-th bot ON A GIVEN BOX waits k*STAGGER so the boxes
    # come up smoothly, but the groups start in PARALLEL (a bot on qwen_a does not
    # wait behind bots on qwen_b). This is what makes the endpoints act as
    # independent groups rather than one globally-serialized launch queue.
    _group_index = {}
    threads = []
    for bot_cfg in bots:
        gid = bot_cfg.get("actor_endpoint", "actor")
        k = _group_index.get(gid, 0)
        _group_index[gid] = k + 1
        t = threading.Thread(target=run_bot,
                             args=(bot_cfg, k * config.STAGGER_SECONDS),
                             name=bot_cfg["username"], daemon=False)
        t.start(); threads.append(t)

    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("\ninterrupted — bots will disconnect as their cycles end")

if __name__ == "__main__":
    main()
