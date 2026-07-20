"""prompts.py — system + user prompt builders for actor and critic."""
import json


# --- PROMPT-SIZE HELPERS -----------------------------------------------------
# The single biggest, least-useful chunk of every actor prompt was the raw game
# snapshot serialized with indent=2. Two things bloated it enormously:
#   1. spatialMap.surfaceHeights — an 11x11 INT matrix. With indent=2, json.dumps
#      puts every one of the ~121 integers on its OWN line (~130 lines, ~500-800
#      tokens) for a grid the actor barely uses: the coder is explicitly told to
#      use helpers.groundY() and NOT to do arithmetic on this grid (see
#      CODE_CONTRACT), and the ASCII `grid` already gives spatial sense. The
#      critic already strips this for the same reason (see critic_prompt).
#   2. spatialMap.note — a ~100-token explainer the legend already covers.
# Plus indent=2 itself inflates the whole object ~30% on whitespace.
def slim_state(state, keep_heights=False):
    """Return a NEW state dict trimmed for prompts (never mutates the live
    snapshot): drop spatialMap.note and (unless keep_heights) surfaceHeights, and
    filter zero-count inventory slots. keep_heights=True retains surfaceHeights for
    the design prompt, which anchors structures to real ground."""
    if not isinstance(state, dict):
        return state
    s = dict(state)
    inv = s.get("inventory")
    if isinstance(inv, dict):
        s["inventory"] = {k: v for k, v in inv.items() if v}
    sm = s.get("spatialMap")
    if isinstance(sm, dict):
        sm = dict(sm)
        sm.pop("note", None)
        if not keep_heights:
            sm.pop("surfaceHeights", None)
        s["spatialMap"] = sm
    return s

def state_json(state, keep_heights=False):
    """Compact (no-indent) JSON of the slimmed state. Compact serialization saves
    another ~30% over indent=2 with no loss of information — models read minified
    JSON fine, and the ASCII grid rows stay intact as separate array strings."""
    return json.dumps(slim_state(state, keep_heights), separators=(",", ":"))

def compact_json(obj):
    """Compact JSON for any prompt payload (e.g. the blackboard) — same tokens
    saved as state_json, for objects that don't need the state-specific trimming."""
    return json.dumps(obj, separators=(",", ":"))

# --- SEEDED HAZARDS ---------------------------------------------------------
# These are the PREDICTABLE ways a survival-Minecraft agent traps or kills
# itself. Seed them once so the bots don't have to learn each the hard way.
# They are GENERAL PRINCIPLES, not task code. Edit this block to add/remove.
# (The self-authored lessons file grows the rest automatically from real
#  failures — this is just the head start for the obvious stuff.)
SEEDED_HAZARDS = """\
KNOWN HAZARDS TO AVOID (general survival principles):
- Reach a block BELOW you via a staircase (step forward-and-down, always a walk-back-up
  path). NEVER mine directly beneath your feet or dig a vertical shaft — you trap
  yourself. If mobility().dropStraightDown grows past 1 while descending, stop.
- PREFER ore reachable WITHOUT descending (cave walls, ravines, cliffs, your own level).
  Tunneling down for ore is a last resort — gather what's reachable on foot first.
- Never dig straight up (falling gravel/sand suffocates you, or you fall).
- Gravel/sand fall when unsupported — don't stand under them or dig them from below.
- Near water/lava: don't dig into a face you can't see behind; wall off flows. Never
  path through lava.
- Don't walk off drops taller than 3 blocks; pillar down or find a slope.
- Eat before food gets low — you can't sprint or regen while starving.
- Night/dark with no shelter or light: retreat or wall yourself in, don't fight in the open.
- Dropped items despawn in ~5 min; collect what you mine promptly.
- Don't attempt impossible things (crafting nonexistent items, recipes you lack inputs/
  tools for, unsure API calls). Verify names against mcData first.
- Structures must be grounded and connected — no floating or disjoint blocks.
- Never move by setting coordinates or teleporting (server kicks you). Travel via
  pathfinder; climb via jump + placing blocks.
- LEAVE NO TRAP: fill any pit/hole you dig with helpers.fillHole() before moving on, or
  staircase instead of a vertical shaft.
"""

CODE_CONTRACT = """\
You write the BODY of an async Mineflayer function. In scope:
  bot     - mineflayer bot (spawned, pathfinder loaded)
  mcData  - minecraft-data (mcData.blocksByName, itemsByName, ...)
  Vec3    - vec3 constructor: new Vec3(x,y,z)
  goals   - pathfinder goals: goals.GoalNear, goals.GoalBlock, goals.GoalXZ ...
  log     - log(msg) sends a debug line to the orchestrator
  helpers - PREFER THESE over raw bot calls; tested and reliable:
      await helpers.gotoXYZ(x,y,z,range?)      travel via pathfinder
      helpers.findBlocks(name,count,maxDist)   -> [Vec3]
      helpers.mobility()  -> {surroundedAtFeet,dropStraightDown,likelyStuckInHole,
                              canJumpUp,blockedSidesAtHead}
      helpers.invCount(name) / helpers.hasItem(name)   FRESH inventory (never stale)
      await helpers.equipItem(name)            -> true/false (won't throw)
      await helpers.placeAt(x,y,z,name)        -> true/false; verifies. Needs solid
                                                  ground directly below (won't float).
                                                  For tables/chests/furnaces on ground.
      await helpers.pillarUp(n,name?)          -> {ok,placed}. Jump+place up. ONLY to
                                                  escape when BURIED; NEVER on surface.
      await helpers.getUnstuck()               -> {ok,method}. Escape ANY bad spot
                                                  (pit/cave/ravine). Use when mobility
                                                  says stuck.
      await helpers.escapeToSurface(targetY?)  -> {ok,method,y}. THE way out when buried:
                                                  mines/pillars up to open sky. Don't
                                                  reimplement escape logic.
      await helpers.collectBlock(name,count,maxDist)  -> {ok,collected,item,have}.
                                                  find+path+equip+dig+pickup. `collected`
                                                  is the VERIFIED gain — trust it, don't
                                                  re-count. USE for wood/dirt/ore.
      await helpers.acquireStone(count?,maxDist?)  -> {ok,status,collected,have}. Tries
                                                  common cases; will NOT dig down. Read
                                                  status, decide next step: 'got'=success;
                                                  'need_tool'=craft/equip a pickaxe;
                                                  'all_buried'/'no_stone_here'=no exposed
                                                  stone (NORMAL on plains) -> call
                                                  digStaircaseDown(8) then
                                                  collectBlock('stone',count,6);
                                                  'blocked'=getUnstuck then retry.
      await helpers.digStaircaseDown(maxDepth?)  -> {ok,hitStone,depth,reason,stoppedFor}.
                                                  Safe climbable staircase down to the
                                                  stone layer (3-6 blocks on plains), or
                                                  stops for a hazard (in stoppedFor).
                                                  hitStone -> collectBlock('stone',count,6).
      await helpers.findMineableStone(maxDist?)  -> {ok,status,x,y,z}. TRAVELS to nearest
                                                  exposed stone and stops there. Do NOT
                                                  gotoXYZ afterward.
      await helpers.collectAnyLog(count)       -> gather nearest wood species. USE for
                                                  wood; don't assume oak/birch/cherry.
      helpers.anyLogInInventory() / anyPlanksInInventory()  -> a species you HAVE, or null
      await helpers.dig(target)                -> {ok}. Dig one block (name/{x,y,z}/Block).
      await helpers.craftItem(name,count)      -> {ok,crafted,count} | {ok:false,reason}.
                                                  On failure reports EXACTLY what's missing
                                                  (read reason/missing, get those first).
                                                  Full chain: auto-crafts+places a table if
                                                  needed. USE for all crafting; never
                                                  bot.craft, don't place tables yourself.
      await helpers.depositToChest(items)      -> {ok,deposited,reason}. items=[{name,count?}],
                                                  omit count = deposit ALL. How a gatherer
                                                  SUPPLIES builders; don't hoard.
      await helpers.withdrawFromChest(items)   -> {ok,withdrawn,reason}. items=[{name,count?}].
      await helpers.smelt(inputName,count?)    -> {ok,smelted,output,count,reason}. Full safe
                                                  furnace op (finds/places furnace, fuels,
                                                  waits, takes output). NEVER bot.openFurnace.
                                                  Smelts cobblestone->stone, sand->glass,
                                                  raw_iron->iron_ingot, log->charcoal. NOTE:
                                                  stone_bricks are CRAFTED not smelted — smelt
                                                  cobble->stone then craftItem('stone_bricks').
      await helpers.placeNearby(name)          -> true/false. Place a block in a good open
                                                  spot beside you (rejects trees/foliage/sand).
      await helpers.placeAtWorkshop(name,WORKSHOP)  -> {ok,noWorkshop?}. Walk to the shared
                                                  workshop and place there so infra CLUSTERS.
                                                  WORKSHOP is in scope (coords or null);
                                                  noWorkshop:true = none sited yet (see below).
      helpers.goodSiteHere()                   -> {x,y,z}|null. Physics-valid workshop spot
                                                  at your location (for the DECIDER).
      helpers.nearbyEntities(maxDist?)         -> [{name,type,kind,dist,pos,id}]
      helpers.nearestHostile(maxDist?)         -> entity|null (for the protector)
      await helpers.drop(name,count?)          -> give/toss items (e.g. share with a bot).
      helpers.groundY(x,z)                     -> {groundY,floorY,found}. REAL ground surface
                                                  Y (absolute coords); floorY=first-course Y.
                                                  USE instead of guessing Y or doing math on
                                                  the surfaceHeights grid.
      await helpers.buildBlocks(cells,name)    -> BUILD ANY SHAPE. cells=[{x,y,z}] YOU design
                                                  (box/L/walls-with-door-gap/roof/any form).
                                                  FLOOR cells may OMIT y ({x,z}) to land on
                                                  real ground automatically. Returns {placed,
                                                  already,failed,failures:[{x,y,z,reason}]}.
                                                  Orders bottom-up so none float; per-cell
                                                  reason (no_support_neighbour/no_item/
                                                  submerged/place_did_not_stick) so you fix
                                                  the DESIGN. Your main build verb — NOT
                                                  limited to straight lines.
      await helpers.buildLine(start,'x'|'z',len,name)  -> one straight run. Else buildBlocks.
      await helpers.fillHole(name?)            -> {ok,filled}. Fill a pit you dug (leave no trap).
      -- PRIMITIVE VERBS (mechanics; YOU choose target/amount/place) --
      await helpers.exploreFor(nameSubstr,opts?)  -> TRAVEL until a block type is in range
                                                  (e.g. '_log','stone'). Use after "none nearby".
      await helpers.equipBestToolFor(block)    -> equip the right tool (name/Block). Before mining.
      await helpers.attack(target,opts?)       -> hit an entity until gone (entity or name).
      await helpers.eat()                      -> eat if hungry.
      await helpers.till(pos?)                 -> dirt/grass -> farmland (needs a hoe).
      await helpers.plant(seedName,pos?)       -> plant a seed on farmland.
      await helpers.harvest(cropName,maxDist?) -> break mature crops & collect.

RULES:
- CHOOSE AND SEQUENCE; don't re-implement mechanics. The helpers are your hands —
  moving/mining/crafting/placing/tilling/attacking are SOLVED. Don't write find/path/
  dig/craft loops. A good body is 3-10 helper calls with logic between, checking each
  {ok}. If you're hand-writing a block loop or raw bot.* call, STOP — there's a helper.
- BREVITY IS MANDATORY: body UNDER 25 lines and ~1500 chars. Long code truncates. No
  long comments, no prose lines — ONLY valid JavaScript statements.
- Use `await` for every async op. Prefer helpers over raw bot.placeBlock/bot.equip/
  reading bot.inventory (those are where failures happen).
- If mobility() shows stuck (surroundedAtFeet>=3 or likelyStuckInHole), your FIRST
  action is `await helpers.getUnstuck()`.
- No process.exit, require(), setInterval, or network connections.
- MOVEMENT: NEVER set bot.entity.position or teleport (server kicks you). Travel via
  gotoXYZ/pathfinder; escape via getUnstuck(). Do NOT pillar up on the surface.
- Only reference in-scope vars (bot, mcData, Vec3, log, helpers, goals). Don't invent
  variables like `mobility`, `state`, `Block`, or write bare words.
- Verify blocks/items exist before use (mcData.blocksByName[name], hasItem).
- GATHER wood/dirt/ore: `helpers.collectBlock(name,count)`. STONE/COBBLE:
  `helpers.acquireStone(count)` — read its `status` for the next move; don't hand-write
  find/path/dig loops or findMineableStone+gotoXYZ (they time out / pass undefined
  coords). Gather small counts (4-8). Trust the returned `collected`; don't re-read
  inventory to "confirm" (stale → false failure).
- DON'T BURY YOURSELF: prefer the nearest source reachable on foot or by staircase, not
  one straight below. After gathering, if mobility shows surroundedAtFeet>=3 or
  likelyStuckInHole, call getUnstuck() before returning.
- WOOD SPECIES: never assume one. Use `collectAnyLog(count)` and
  `anyPlanksInInventory()` / `craftItem('<species>_planks')` with a species you HAVE
  (craftItem auto-substitutes if you guess wrong).
- CRAFT: `helpers.craftItem(name,count)` (finds/places a table). Check {ok,reason}.
  Never bot.craft or bot.recipesFor.
- BUILD any structure (floor/wall/roof/enclosure): `helpers.buildBlocks(cells,name)` —
  compute the FULL {x,y,z} list in ONE call, don't loop placeAt. Heights from
  `groundY(x,z)` or omit y on floor cells; NEVER do arithmetic on surfaceHeights (it is
  indexed by offset from the bot, not world coords — that puts blocks inside terrain).
  Read `failures[]` and fix the DESIGN; never retry an identical failing coordinate.
- COMMUNITY WORKSHOP: WORKSHOP ({x,y,z} or null) and IS_DECIDER (true/false) in scope.
  * Shared infra (crafting_table/furnace/chest) when a workshop EXISTS:
    `const r = await helpers.placeAtWorkshop('furnace', WORKSHOP);` (r.noWorkshop=true
    means none sited yet).
  * Needed shared infra but WORKSHOP is null and you are NOT the decider: do the
    immediate work if you can (placeNearby on good ground) and RETURN a summary with
    `need_workshop:true`. Do NOT found the workshop yourself.
  * IS_DECIDER siting it: stand on flat open ground near where the group works, then
    `const site = helpers.goodSiteHere();` if site is not null RETURN
    `{establish_workshop: site}` (optionally place the first table). Not in a tree/cliff.
- Only call helpers that EXIST above. Don't invent names (nearbyBlockCensus, craftCraft,
  collectFromDistance, collect) — instant failure. Gather = collectBlock/collectAnyLog only.
- Gather failed "none nearby" / "no logs of any species": do NOT retry in place. Call
  `helpers.exploreFor('_log')` (or 'stone', etc.) THEN gather. Never loop the same
  in-place collect that reported nothing.
- Mobs: `helpers.nearbyEntities()` / `helpers.nearestHostile()` — CALL the helper.
- End with `return <summary>` — a small JSON object, e.g. {collected:'oak_log', count:3}.
- Guard risky lookups; if you can't do the task, `return {error:'reason'}`.
Return ONLY a ```javascript code block, nothing else.
"""

ACTOR_SYSTEM = """You are the mind of an autonomous Minecraft agent in an ongoing \
society. You act through Mineflayer code. \
You are practical, incremental, and you prefer reusing proven skills over rewriting them."""

CRITIC_SYSTEM = """You are a strict but fair evaluator. You judge whether a Minecraft \
agent's action achieved its stated task, using only the before/after game state and \
the execution result. You reply with a single JSON object and nothing else."""

def propose_prompt(purpose, state, skill_manifest, blackboard, recent,
                   recent_failures=None, lessons="(none)",
                   goal="(no specific long-term goal)", progress="(none yet)",
                   community_structures="(none known yet)", blocked_prereqs=None,
                   broken_capabilities="", stuck_loop="",
                   workshop="(no workshop info)", is_decider=False, plan="(no plan)",
                   structure_purpose="", community_needs="", designs=""):
    # A compact restatement of identity for the self-check line (first sentence of
    # purpose, which is the "You are the X" identity clause).
    purpose_short = purpose.split(".")[0].strip() if purpose else "an agent with a purpose"
    fail_block = "(none)"
    if recent_failures:
        fail_block = "\n".join(f"- {f}" for f in recent_failures)
    # Proactive tech-tree bootstrap: read the ACTUAL inventory and surface concrete
    # tool/material gaps so the proposer stops picking self-blocking tasks like
    # "mine cobblestone WITH a stone pickaxe" when no stone pickaxe (or its inputs)
    # exists yet. This is general reasoning over what's held, not a hardcoded quest.
    inv = (state or {}).get("inventory", {}) or {}
    def _has(substr):
        return any(substr in k for k in inv)
    def _count(substr):
        return sum(v for k, v in inv.items() if substr in k)
    boot = []
    has_wood_pick = _has("wooden_pickaxe")
    has_stone_pick = _has("stone_pickaxe")
    has_any_pick = any(_has(p) for p in ("pickaxe",))
    has_logs = _has("_log")
    has_planks = _has("_planks")
    # cobblestone (or deepslate) can only be mined with a pickaxe; a stone pickaxe
    # needs cobblestone, which needs a wooden pickaxe, which needs planks+sticks.
    if not has_any_pick:
        if has_planks or has_logs:
            boot.append("You have NO pickaxe. First craft a WOODEN pickaxe (needs "
                        "planks + sticks, which come from logs). Do that before any "
                        "task that requires mining stone/ore.")
        else:
            boot.append("You have NO pickaxe and NO wood. The very first step is to "
                        "gather logs (helpers.collectAnyLog), then make planks, "
                        "sticks, and a WOODEN pickaxe — in that order.")
    elif has_wood_pick and not has_stone_pick:
        cobble = _count("cobble") + _count("cobbled_deepslate")
        if cobble >= 3:
            boot.append("You have a wooden pickaxe and enough cobblestone — you can "
                        "craft a STONE pickaxe now.")
        else:
            boot.append("You have a wooden pickaxe but not a stone one. Mine "
                        "cobblestone/deepslate WITH THE WOODEN PICKAXE (not a stone "
                        "one you don't have yet), then craft the stone pickaxe.")
    # never propose mining a material 'using the stone pickaxe' if none is held
    if not has_stone_pick:
        boot.append("Do NOT propose any task phrased as using a stone pickaxe — you "
                    "don't have one. Phrase mining tasks around the tool you DO have.")
    bootstrap_block = "\n".join(f"- {b}" for b in boot) if boot else \
        "(your basic tools look sufficient for now)"
    # Floater-only: a focused view of unmet community needs (passed non-empty only
    # for flexible members). Empty string collapses to nothing for specialist bots.
    needs_section = f"\n{community_needs}\n" if community_needs else ""
    # Builder-only-ish: this bot's unfinished persistent structure designs.
    designs_section = f"\n{designs}\n" if designs else ""
    prereq_block = "(none — you are not currently blocked on known materials)"
    if blocked_prereqs:
        b = blocked_prereqs[0]
        needs = ", ".join(f"{m['count']} {m['name']}" for m in b.get("missing", []))
        prereq_block = (
            f"Last cycle you could NOT complete \"{b.get('blocked_task','(task)')}\" "
            f"because you were missing: {needs}.\n"
            f"DO NOT re-propose that blocked task yet. Instead, propose the task that "
            f"OBTAINS the first missing material above (mine/craft/gather it). If that "
            f"material ALSO needs something you lack, go one level deeper. Work back to "
            f"the first thing you can actually do right now with your current inventory "
            f"and tools. Once you have the materials, the blocked task becomes doable.")
    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
YOUR LIFE PURPOSE (who you are): {purpose}

YOUR LONG-TERM GOAL (the project you are slowly working toward):
{goal}

PROGRESS YOU'VE MADE TOWARD THAT GOAL SO FAR:
{progress}

CURRENT GAME STATE:
{state_json(state)}

SHARED BLACKBOARD (community notes from all agents):
{compact_json(blackboard)}

SHARED COMMUNITY INFRASTRUCTURE (built by ANY agent — this belongs to everyone):
{community_structures}
You are part of a COMMUNITY, not alone. This infrastructure is shared. Before
building a crafting table, furnace, chest, etc., USE one that already exists if it's
reasonably close — don't duplicate what the community already has. When you do build
shared infrastructure, consider placing it somewhere central and useful to everyone,
and note it on the blackboard so others know it's there. Think as a group.

COMMUNITY WORKSHOP (the group's shared build site — where infrastructure clusters):
{workshop}

VILLAGE PLAN (the shared layout the whole community builds against — READ THIS):
{plan}
Coordinate through the plan, don't improvise a separate settlement. If you are the
city builder (the decider) and there is NO plan yet, propose one: a handful of named
build sites (e.g. shelter, storage, wall segments, gate, path) anchored at the
workshop, each with an approximate position. If a plan EXISTS, pick an OPEN slot,
claim it, and build THAT — so the settlement comes together coherently instead of
each agent building at random. Build where the plan says, not wherever you happen to
stand.

{structure_purpose}
{designs_section}{needs_section}
BUILDING ACROSS CYCLES (read if this task builds/extends/decorates a structure):
A structure is built over SEVERAL cycles against a saved DESIGN — the exact
{{x,y,z}} blocks you reason it should be made of. If you set "build_intent": true,
you'll then author (or continue) that design and the system will track which blocks
are actually placed, handing you the still-missing ones next cycle until it's whole.
To CONTINUE an unfinished design listed above, set "build_intent": true and put its
id in "design_id" — don't start a new structure while one is unfinished. Set
"build_intent": false for gathering, mining, crafting, farming, or delivering.

SKILLS YOU ALREADY HAVE (reuse when possible; reliability shown as ok/fail):
{skill_manifest}

RECENT ATTEMPTS (most recent last):
{recent or '(none)'}

TASKS YOU RECENTLY FAILED OR GAVE UP ON — do NOT propose these again unless your
situation has clearly changed (e.g. you now have the required tool/materials).
Choose a DIFFERENT task, or a smaller prerequisite step toward one of them:
{fail_block}

LESSONS LEARNED FROM PAST FAILURES (yours and other agents'):
{lessons}

BLOCKED PREREQUISITES (act on this FIRST if present):
{prereq_block}

{stuck_loop}

{broken_capabilities}

YOUR CURRENT TOOL/TECH SITUATION (computed from your actual inventory — obey it):
{bootstrap_block}

Pick the single best NEXT TASK that moves you one concrete step closer to your
LONG-TERM GOAL, given your current state and what you've already done. Think like
a human working a big project slowly: what's the next small, verifiable step?

STEP 0 — SITUATIONAL SELF-CHECK (do this FIRST, before anything else). You are not
just a resource collector — you are {purpose_short}. Pause and honestly assess:
  - Given WHO I AM and WHERE I AM right now, is my current trajectory actually
    serving my purpose? Or have I drifted into just accumulating materials?
  - Look at your position (Y-level, whether you're underground vs. on the surface),
    your inventory (do I already HAVE plenty of what I keep gathering?), and your
    progress. A protector deep in a cave is not protecting anyone. A city builder
    hoarding cobblestone in a hole is not building a city.
  - If your situation does NOT serve your purpose, your next task should be to
    CORRECT that (e.g. return to the surface, go to the community area, or start
    actually building/defending) — not to gather yet more materials.
  - You MAY deliberately choose a situation that looks odd (e.g. settling in a
    cavern) IF you can justify how it serves your purpose. If you make such a
    choice, you MUST record your reasoning in "situation_note" so the community
    understands it.
Only AFTER this self-check, proceed to prerequisites below.

PREREQUISITES FIRST: before proposing to craft or build something, check whether you
actually HAVE its inputs in your inventory right now. If not, the correct next task
is to GET the missing input — and if THAT input also has a prerequisite, get that
first. Work backwards to the first thing you can actually do now. For example, if a
task needs a material you don't have, and that material needs a tool you don't have,
your task should be making/obtaining that tool (or its inputs). Do NOT repeatedly
propose the final goal when you lack its inputs — the lessons above may already tell
you the chain. If you keep hitting the same wall, drop to the simplest missing
prerequisite and do that.

Reply with ONLY this JSON:
{{"situation_assessment": "<1-2 sentences: does my current situation/location serve
    my purpose right now, or have I drifted into pure collecting? Be honest.>",
  "situation_note": "<null, OR — if you're choosing to act against the obvious read
    of your purpose (e.g. staying underground, settling in a cave) — a short
    justification for the community blackboard explaining WHY it serves your goal>",
  "task": "<short imperative task>",
  "reason": "<how this advances the long-term goal>",
  "reuse_skill": "<existing skill name or null>",
  "build_intent": <true ONLY if this task physically PLACES blocks to build, extend,
    or decorate a structure; false for gathering/mining/crafting/farming/delivering>,
  "design_id": "<null, OR — to CONTINUE one of your unfinished designs listed above —
    that design's id>",
  "plan_action": "<null, OR a village-plan action. As the city builder with NO plan
    yet, propose one: {{\"propose\": [{{\"id\":\"shelter\",\"name\":\"shelter\",
    \"kind\":\"house\",\"pos\":{{\"x\":..,\"y\":..,\"z\":..}}}}, ...]}}. To take an
    open slot before building it: {{\"claim\":\"<slot_id>\"}}. After you finish
    building a slot: {{\"complete\":\"<slot_id>\"}}. Otherwise null.>",
  "success_looks_like": "<the ACHIEVED OUTCOME as a QUALITATIVE gain, never an exact
    number — e.g. 'a stone_pickaxe is in inventory' or 'more cobblestone than before'
    or 'at least some logs were gathered'. Do NOT write exact quantities ('increased
    by 5', 'exactly 10'): collecting MORE than intended, or a bit less but still
    making progress, is SUCCESS, not failure. Define success by what you GAIN or
    build, never by side effects like materials being used up or leftover counts.
    Overshooting a target is always success.>"}}"""},
    ]

def design_prompt(task, purpose, state, existing=None, missing_cells=None,
                  build_rules="", anchor_hint="", lessons="(none)"):
    """Ask the builder to AUTHOR (or CONTINUE) a persistent structure design: the
    explicit list of {x,y,z} blocks the structure is made of, plus a self-review of
    whether that list actually achieves the purpose. The SHAPE is entirely the
    model's decision — we only persist and verify it (see structures.py designs).

    existing: a prior design dict when continuing (so the model refines the SAME
              structure). missing_cells: cells the world still lacks, for context.
    anchor_hint: where to anchor (workshop / plan-slot coords), so multiple builders
                 don't each anchor a structure somewhere different."""
    cont = ""
    if existing:
        miss = missing_cells or existing.get("missing", [])
        cont = (f"\nYOU ARE CONTINUING an existing design (id \"{existing.get('id')}\", "
                f"{existing.get('name')}, purpose {existing.get('purpose')}, material "
                f"{existing.get('block')}). It has {existing.get('total',0)} blocks; "
                f"{len(miss)} are still missing in the world. Keep the SAME overall "
                f"structure and material. Return the FULL intended cell list again "
                f"(the system re-checks it) — refine or extend it if your earlier "
                f"design was incomplete for its purpose, but do not switch to a "
                f"different building.\n")
    anchor = f"\nANCHOR: {anchor_hint}\n" if anchor_hint else ""
    build_block = f"\n{build_rules}\n" if build_rules else ""
    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
You are DESIGNING a structure to build over several cycles. Output the exact blocks
it is made of. YOU decide the shape — there is no template.

TASK: {task}
STRUCTURE PURPOSE: {purpose}
{cont}{anchor}
CURRENT GAME STATE (use position, spatialMap.origin and surfaceHeights to anchor to
REAL ground; do not invent a Y that floats inside or above terrain):
{state_json(state, keep_heights=True)}
{build_block}
LESSONS (obey):
{lessons}

DESIGN RULES:
- Output the COMPLETE set of {{x,y,z}} cells (absolute world coordinates) that make
  up the structure — every wall block, floor block, roof block, corner. Not a
  sketch; the actual blocks.
- Anchor to real ground: floor cells sit at ground level (see surfaceHeights /
  groundY); each higher course is one Y above the one below. Blocks can't float —
  every cell must have a solid neighbour below or beside it once lower cells exist.
- Keep it BUILDABLE and reasonably sized (aim for well under ~120 cells; a small
  hut, a wall segment, a path — not a castle). It's fine to build a big thing as
  several designs over time.
- Choose ONE primary material ("block") the bot has or can readily get.
- THEN SELF-REVIEW before you answer: mentally walk the cells and check they
  actually ACHIEVE the purpose — a shelter is fully enclosed with a roof and a
  1-block door gap; a wall has no holes a mob fits through; a path is continuous.
  If your first cell list fails its own purpose, FIX the cells before returning.
  Put the outcome of that check in "review".

  - PHYSICS VALIDATION CHECKLIST — before returning, verify your cells pass ALL of these:
  1. SUPPORT CHECK: Every cell that is NOT on the ground layer must have another
     cell in your design directly below it (y-1) OR beside it as a support. No floating blocks.
  2. GROUND ANCHORING: Floor/footprint cells should either omit 'y' (letting helpers
     place them on actual ground) or use groundY(x,z) to find the real surface.
  3. ENCLOSURE CHECK (for shelter purpose): Walk the perimeter — are all 4 sides
     present? Is there a roof covering the top? Is there exactly ONE 1-block gap for a door?
  4. CONTINUITY CHECK (for wall purpose): The wall forms a continuous barrier with
     no gaps wider than 1 block. Check each segment connects to the next.
  5. BUILD ORDER: Your cells can be ordered bottom-up (lower Y first). If a cell
     requires another to exist first, that supporting cell must be in your list.
  
Reply with ONLY this JSON (no prose, no code fences):
{{"name": "<short structure name, e.g. 'north wall' or 'starter hut'>",
  "purpose": "<shelter|wall|storage|lighting|path|decoration|other>",
  "block": "<primary block/material name>",
  "cells": [{{"x": <int>, "y": <int>, "z": <int>}}, ...],
  "review": "<1-2 sentences: does this cell list achieve the purpose? what did you
     fix?>"}}"""},
    ]


def code_prompt(task, success_looks_like, state, attempt_history=None,
                total_attempts=1, lessons="(none)", build_rules="", design=None,
                structure_purpose=""):
    """attempt_history: list of {attempt, code, error, stack, critic_reason}.
    Showing the model its OWN prior code + every failure is what stops it from
    regenerating the same broken code.

    build_rules: structures.build_mechanics_block(). THIS IS LOAD-BEARING. Until
    now the build mechanics (groundY vs. grid math, buildBlocks, don't-float,
    read-the-failure-reason, read spatialMap) were injected ONLY into the PROPOSER,
    which does not write code. The coder — the model that actually chooses the
    placement coordinates — never received them, so it hardcoded Y from the
    surfaceHeights grid and ignored placeAt's return value. That is why structures
    came out incoherent. Always pass this in."""
    history_block = ""
    if attempt_history:
        parts = []
        for h in attempt_history:
            parts.append(f"""--- ATTEMPT {h['attempt']} (FAILED) ---
Code you wrote:
```javascript
{h['code']}
```
Runtime error: {h.get('error') or '(none — code ran but did not achieve the goal)'}
Stack: {(h.get('stack') or '')[:400]}
Logs it emitted: {h.get('logs') or '(none)'}
Why it failed: {h.get('critic_reason') or '(unknown)'}""")
        history_block = (
            "\nYOU HAVE ALREADY FAILED THIS TASK. Here is EVERY prior attempt. "
            "Do NOT repeat any approach shown below — it does not work. "
            "Diagnose the root cause and try something MECHANICALLY DIFFERENT:\n\n"
            + "\n\n".join(parts) + "\n")

    escalation = ""
    n = len(attempt_history or [])
    if n >= 2:
        escalation = (
            f"\n>>> This is attempt {total_attempts}. Small tweaks have not worked. "
            "STOP adjusting details. Reconsider the whole approach: are you using the "
            "wrong API, wrong block/item name, missing a prerequisite (tool, "
            "proximity, line of sight), or is the task itself impossible from here? "
            "If it may be impossible right now, return {error:'<why>'} so the agent "
            "can pick a different task.\n")

    build_block = f"\n{build_rules}\n" if build_rules else ""

    # If this is a build against a persistent design, hand the coder the EXACT
    # still-missing cells and tell it to place precisely those — no re-deriving
    # coordinates, no drifting to a new structure. This is what makes multi-cycle
    # builds converge on the same design.
    design_block = ""
    if design and design.get("cells"):
        to_build = design.get("to_build") or design.get("missing") or design["cells"]
        cells_json = json.dumps(to_build[:80])
        more = "" if len(to_build) <= 80 else \
            f"\n  (…{len(to_build)-80} more cells; place these first, the rest come next cycle.)"
        design_block = (
            "\nBUILD THIS DESIGN — a persistent structure tracked across cycles. Build "
            "EXACTLY the cells below; do NOT invent other coordinates or start a "
            "different structure:\n"
            f"- name: {design.get('name')} | purpose: {design.get('purpose')} | "
            f"material: {design.get('block')}\n"
            f"- Still-missing cells to place THIS run (a JSON array you can paste "
            f"directly as a JS array literal):\n{cells_json}{more}\n"
            "- Do it in essentially ONE call: put that array in a const CELLS and call "
            "`await helpers.buildBlocks(CELLS, '" + str(design.get("block", "cobblestone"))
            + "')`. First make sure you HAVE enough of the material (gather/craft, or "
            "withdraw from a shared chest if short); if you can't get it, "
            "return {error:'need <material>'}.\n"
            "- Read the returned failures[]: for no_support_neighbour, the lower "
            "supporting cell in THIS list must go first (buildBlocks already orders "
            "bottom-up, so this usually means that support cell isn't in the design — "
            "just build what you can and return the result). RETURN buildBlocks's "
            "result object so progress can be verified.\n")

    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
TASK: {task}
SUCCESS LOOKS LIKE: {success_looks_like}

CURRENT GAME STATE:
{state_json(state)}

{SEEDED_HAZARDS}
{build_block}{design_block}
{structure_purpose}
LESSONS YOU AND OTHER AGENTS LEARNED FROM PAST FAILURES (obey these):
{lessons}
{history_block}{escalation}
{CODE_CONTRACT}"""},
    ]

def name_prompt(task, code):
    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
This skill worked. Give it a reusable identity.

TASK IT ACCOMPLISHED: {task}
CODE:
{code}

Reply with ONLY this JSON:
{{"name": "<snake_case_verb_noun>",
  "description": "<one line, what it does>",
  "keywords": ["<lowercase>", "<search>", "<terms>"]}}"""},
    ]

def critic_prompt(task, success_looks_like, run_result, structure_goals=""):
    """structure_goals: structures.purpose_block(). The critic decides whether a
    build 'succeeded', and a slot then gets marked BUILT off the back of that. If it
    doesn't know what a shelter is FOR, it grades by 'some blocks moved' and passes
    half-structures — which is how walls with no roof got marked complete.

    Also note the `before`/`after` slices below now carry spatialMap. The prompt has
    always told the critic to 'use the block-census / spatialMap evidence', but
    spatialMap was never actually included in the slice — it was grading geometry
    from a field it could not see. Only the ASCII grid + origin are passed (not the
    surfaceHeights matrix), to keep the payload small."""
    logs = run_result.get("logs") or []

    def _slice(side, with_legend=False):
        d = run_result.get(side) or {}
        out = {k: d.get(k) for k in
               ("position", "inventory", "health", "nearbyBlockCensus", "mobility")}
        sm = d.get("spatialMap") or {}
        if sm.get("grid"):
            # ONLY the grid + origin. Deliberately NOT sm["note"] (a ~400-char
            # explainer aimed at the coder) and NOT sm["surfaceHeights"] (an 11x11
            # int matrix). Sending those doubled the critic's prompt and blew past a
            # small-context critic's window -> 400 Bad Request on every judge call.
            out["spatialMap"] = {"origin": sm.get("origin"), "grid": sm.get("grid")}
            if with_legend:
                out["spatialMap"]["legend"] = sm.get("legend")
        return out

    slim = {
        "ok_no_exception": run_result.get("ok"),
        "returned": run_result.get("result"),
        "error": run_result.get("error"),
        "logs_the_code_emitted": " | ".join(logs)[:600] if logs else "(none)",
        # legend once (it's identical in both) rather than twice
        "before": _slice("before", with_legend=True),
        "after": _slice("after"),
    }
    goals_block = f"\n{structure_goals}\n" if structure_goals else ""
    return [
        {"role": "system", "content": CRITIC_SYSTEM},
        {"role": "user", "content": f"""\
TASK THE AGENT ATTEMPTED: {task}
SUCCESS CRITERION: {success_looks_like}
{goals_block}
EXECUTION REPORT (before vs after game state):
{json.dumps(slim, indent=2)}

The two `spatialMap.grid` values above are top-down views of the actual blocks
(before vs after). Diff them to SEE what this run really built — that is your
evidence for whether a build advanced the named structure or just scattered blocks.

Did the agent achieve the task? Judge ONLY from evidence: inventory changes,
position changes, block-census changes, the error, and the emitted logs.
Do not give credit for intent — only for observed change.

REQUIRE A CAUSAL CHANGE — THIS RUN must have caused the outcome. Compare BEFORE vs
AFTER. If the target thing was ALREADY present in 'before' and nothing relevant
changed, that is FAILURE (the skill was a no-op) — the agent did not accomplish
anything this run. A no-op that reports an item it already had is NOT success.

JUDGE BY DIRECTION, NOT EXACT QUANTITY. Success means THIS run moved the world toward
the goal. The direction of change is what matters, never hitting a precise number:
  • Task wanted "5 cobblestone" and the bot mined 7 → SUCCESS (overshoot is success).
  • Task wanted "10 logs" and the bot got 3 → SUCCESS if it gained logs it didn't
    have (real progress toward the goal); the next cycle continues the work.
  • Task wanted an item and that item is now newly in inventory → SUCCESS, regardless
    of how much of anything else was used, left over, or overshot.
NEVER fail a task merely because: the count differs from a number in the criterion,
overshoot happened, leftover materials remain, a different-but-valid variant was
obtained (e.g. acacia logs when the phrasing said oak — any log counts), or the
exact inventory doesn't literally match the wording. Judge the GOAL, not the spec's
arithmetic. Only fail for genuine NO PROGRESS: nothing relevant changed at all, an
error stopped the work, or the run made things worse.

BUILDING IS INCREMENTAL — grade progress TOWARD THE STATED STRUCTURE, not raw block
count. Judge against SUCCESS CRITERION above (what this build was supposed to become —
e.g. "a shelter enclosing a 3x3 space", "a wall closing the north gap"). A build run is
SUCCESS when it placed new blocks that ADVANCE that stated structure: more of the wall
the task named, a course of the shelter it described. "Placed 7 of 9 planks" of the
intended structure is SUCCESS. A block a coordinate or two off the exact target is still
SUCCESS if it advances the same structure (placement is approximate; the design is what
matters). Do NOT demand completion — multi-cycle builds finish over many runs.
  • Fail when ZERO new blocks were placed (nothing changed) or an error blocked it.
  • Also fail a build that placed blocks but did NOT advance the stated structure — e.g.
    the task was a shelter/enclosure and the run only laid a disconnected straight scrap
    or scattered blocks unrelated to the intended shape. Placing SOMEWHERE is not the
    same as building the thing that was asked for. Say so in "reason" (e.g. "blocks
    placed but they don't advance the enclosure the task described — no wall/gap was
    closed") so the coder fixes the DESIGN (the cells passed to buildBlocks), not just
    the block count. Use the block-census / spatialMap evidence to judge this; do not
    grade fine geometry you can't see, only whether the run plausibly moved toward the
    named structure vs. dropped unrelated blocks.

IMPORTANT — SAFETY side effects, judged by RECOVERABILITY not raw wall count. The
"mobility" field describes the bot's physical situation. A bot standing in a shallow
1-deep hole it just mined (surroundedAtFeet 3-4 but recoverableByJump=true and
canJumpUp=true) is NORMAL after mining and is NOT a trap — do not fail for that.
Mark FAILURE for trapping ONLY when the after-state is genuinely hard to escape:
likelyStuckInHole is true, OR blockedSidesAtHead has 3+ sides (walled in at head
height), OR dropStraightDown is large (fell into a deep pit) with walls around. If
recoverableByJump is true or canJumpUp is true with a small drop, treat mobility as
FINE and judge the task on its outcome alone.

If it FAILED, your "reason" must be a concrete, actionable hypothesis the coder
can fix — name the likely cause (wrong block/item name, target out of range, no
matching block found, missing tool, wrong API call, timeout, OR trapped itself by
digging down) based on the evidence, not a vague restatement.

Reply with ONLY this JSON — no preamble, no explanation before it, no ``` fences.
Your FIRST character must be {{ . Keep "reason" to one sentence so the object is
never cut off:
{{"success": true|false,
  "confidence": 0.0-1.0,
  "reason": "<evidence + actionable cause if failed>"}}"""},
    ]


def lesson_prompt(task, attempt_history):
    """Turn a give-up into a durable, GENERAL lesson the model writes itself.
    This is what lets the society improve without a human editing prompts."""
    attempts = "\n\n".join(
        f"Attempt {h['attempt']}:\n```javascript\n{h['code']}\n```\n"
        f"error: {h.get('error')}\nlogs: {h.get('logs')}\n"
        f"why it failed: {h.get('critic_reason')}"
        for h in attempt_history)
    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
You just failed this task after several tries and are giving up:
TASK: {task}

Here is everything you tried and why each failed:
{attempts}

Write ONE short, GENERAL lesson (max 25 words) that would help you or another
agent AVOID this class of mistake in the future. It must be a transferable
principle, NOT specific to this exact spot or coordinates. Good examples:
"Check mcData.itemsByName before crafting; some items don't exist."
"Pathfind within 3 blocks of a target before calling bot.dig on it."
Bad (too specific): "Don't mine at x=100 z=200."
If there is no generalizable lesson (just bad luck), reply with exactly: NONE

Reply with ONLY this JSON:
{{"lesson": "<the lesson, or NONE>"}}"""},
    ]


def revise_skill_prompt(skill_name, description, old_code, task,
                        attempt_history, lessons="(none)"):
    """Ask the actor to rewrite a skill that has been failing. The revised code
    keeps the same PURPOSE but fixes the flaw — like a human improving a
    technique that stopped working."""
    fails = "\n\n".join(
        f"Failure {h['attempt']}: error={h.get('error')} | logs={h.get('logs')} "
        f"| why={h.get('critic_reason')}"
        for h in attempt_history)
    return [
        {"role": "system", "content": ACTOR_SYSTEM},
        {"role": "user", "content": f"""\
A saved skill named "{skill_name}" ({description}) has been FAILING when reused.
You are going to REWRITE it so it works reliably. Keep its PURPOSE the same —
other tasks depend on it doing what its name says — but fix the flaw.

The current (failing) code:
```javascript
{old_code}
```

It was last used for this task: {task}
Recent failures:
{fails}

LESSONS learned across the society (obey these):
{lessons}

{SEEDED_HAZARDS}

Rewrite the skill to be more robust: add guards, verify blocks/items exist via
mcData, pathfind close before acting, handle the "not found / out of range /
already done" cases, and follow the hazards above. Same signature and contract:
{CODE_CONTRACT}"""},
    ]
