# ⭐ PROJECT DIRECTION — READ THIS FIRST (owner directive, 2026-07-06)

*This section is the north star. If any future work — including anything below it
in this file — conflicts with the priorities here, these priorities win. Written
after ~48 hours sunk into mechanical tech-tree debugging (cobblestone mining) made
it clear the effort was pointed at the wrong layer.*

## What this project is actually about

The goal is **emergent civilization**: do autonomous agents develop politics,
currency, trade, and *logical* (not random) settlement when left to run together?
That is the research question. Everything else is cost, not content.

**The owner does NOT care** whether an agent figures out a pickaxe in 10 cycles or
75. The mechanical tech tree (wood → stone → tools → smelting → building) is
PLUMBING. Watching it self-solve is mildly interesting but slow, and it is NOT the
point. Spending sessions fixing each little mechanical bug is the failure mode we
are explicitly rejecting.

## The two-layer split (keep these separate in your head)

1. **Mechanical layer** (survival, tech tree, pathing, mining, crafting). Goal for
   this layer: **reliable enough to DISAPPEAR.** It should not consume design
   attention. It is a means, never an end.
2. **Social layer** (proposals, voting, norms, trade, currency, governance, city
   planning). Goal: **this is where all the interesting research lives.** This is
   what we actually want to observe and grow.

## Priority order for any future session

1. Do NOT let the mechanical layer become the project again. If agents are stalling
   on plumbing, the right move is usually to **bypass it** (bootstrap/gift the
   resources), NOT to spend the session perfecting it. See "Bootstrapping" below.
2. Advance the SOCIAL layer (Parts A/B of this doc) even if the mechanical layer is
   imperfect. **The old rule "make survival solid first, THEN do governance" is
   REVOKED.** Governance work is no longer gated behind a perfect survival loop.
   A slightly janky bot that still trades and votes teaches us more than a perfect
   bot that only mines.
3. Only fix a mechanical bug directly if it actively breaks the social layer (e.g.
   a crash that kills the host mid-experiment). Otherwise, bootstrap past it.

## The fidelity rule (answers "are we hardcoding, or adding Minecraft truths?")

Minecraft is learned by experimentation, with legitimate outside help (the in-game
recipe book; a human glancing at the wiki). Helpers should mirror that, and no
more. Three categories:

- **(A) Minecraft truth / wiki-equivalent** — game facts the agent can't see or
  would only learn by tedious trial (cobblestone smelts to stone; wood pickaxe
  mines stone; a block needs a solid neighbor to place). Encoding these is FINE —
  it's the wiki a human would check. Not a loss of agency.
- **(B) Mechanical execution** — operating the controls (open→fuel→wait→take a
  furnace; cut a staircase; climb out of a hole). Wrapping these is FINE — a human
  doesn't "decide" each API call, they just "smelt."
- **(C) Strategic choice** — choosing between valid options: what fuel to burn,
  how deep to commit before giving up, dig-down vs. travel vs. wait, WHERE a
  building goes, who leads, what to trade. **This belongs to the LLM, NOT the
  helper.** If a helper must make such a choice, it should take it as a PARAMETER
  the LLM passes, or REPORT the situation and let the LLM decide the next step.

Litmus test: *"Would two competent players reasonably choose differently here?"*
If yes, it's (C) — the LLM decides. If no, it's (A) or (B) — a helper may own it.

Known current violations to fix opportunistically (not urgently): `acquireStone`
silently digs down instead of reporting `no_stone_here` and letting the LLM choose
(now that the LLM has `digStaircaseDown` and is told about it); `smelt` hardcodes
fuel order instead of taking an optional `fuel` param. These are (C) leaks. They're
tolerable while bootstrapping the mechanical layer away, but they should not be
copied as a pattern into the social layer, where (C) is the entire point.

## Bootstrapping (the main lever for getting to the interesting part fast)

Because the mechanical layer is cost, not content, it is legitimate — encouraged —
to START agents past it: spawn them with tools, a stocked base, chests of
cobblestone/wood/food, a crafting table and furnace already placed. This is the
"give them a starter kit" move, and it is NOT cheating any more than a tabletop
scenario starting players at level 5. It converts "years of tech-tree debugging"
into "the social experiment starts on cycle 1." Consider a `config` flag like
`BOOTSTRAP_INVENTORY` / `BOOTSTRAP_BASE` that pre-loads state so runs begin at the
point where social decisions can actually happen.

The current per-agent goals in `config.py` are all CONSTRUCTION ("build a stone
village", "make the community defensible"). Even a flawless run of those yields a
village, not a civilization. To get social behavior, goals must create the
CONDITIONS for it: asymmetric resource access (so trade is necessary), a shared
scarce resource (so governance is necessary), and agent-set goals (so hierarchy
can form). Designing those conditions is higher-value than any mechanical fix.

---

# Plan: Semi-Emergent Collective Decisions + Scaling to ~10 Agents

A future-work roadmap for the SOCIAL layer. Per the directive above, this is NO
LONGER gated behind a perfect survival loop — advance it in parallel, bootstrapping
past mechanical gaps as needed.

Target, stated precisely: **any agent can initiate a collective decision when its
own judgment says the group should decide something — about content we never
specified — and the outcome materially binds behavior.** The *mechanism* (a way to
propose and vote) is an affordance we provide; the *political life* that flows
through it (what gets raised, when, by whom, which norms stick, who leads) is
unscripted. This is "semi-emergent," which is the realistic and still-impressive
target. Fully autonomous governance-from-nothing is out of scope.

---

## Part A — The build (in dependency order)

Build the mechanism at LOW population (2-3 agents) first. It is far cheaper to
debug proposal/vote logic at 2 agents and fast cycles than to discover its bugs at
10 agents with multi-minute cycles. Scale population LAST.

### Phase 1 — Agent-initiated proposals (the spontaneity lives here)
The trigger must come from the agent, not a clock. Do NOT prompt "do you want to
vote on something." Instead, add "raise a proposal" as one *option* in the agent's
normal per-cycle decision, and let its own reasoning decide when a situation calls
for it (contested resource, conflicting goals with another bot, a shared build,
a threat needing coordinated response).

- Extend the propose step so the agent can return either a normal task OR a
  `propose` action: `{action:"propose", topic, options:[...], why}`.
- Proposals post to a new `state/proposals.json` (open proposals) — reuse the
  atomic-write + lock pattern from lessons.py / blackboard.
- Success criterion for this phase: agents raise proposals *unprompted*, about
  things you didn't seed. No voting yet — just prove spontaneous initiation works.

### Phase 2 — Voting rounds (mechanical, cheap)
When an open proposal exists, the orchestrator collects each agent's vote:
- One LLM call per agent: given the proposal + their purpose/goal + current state,
  return `{vote, reasoning}`. Structurally identical to the critic's JSON verdict.
- Tally, record outcome + per-agent reasoning to `state/decisions.json` (the
  civilization's history/ledger).
- Design choices to decide here: quorum (do all agents vote, or any present?),
  threshold (simple majority? supermajority for norms?), tie-breaking, and whether
  abstention is allowed. Keep it simple first: majority of connected agents.

### Phase 3 — Consequence (this is what separates real politics from theater)
A decision only *means* something if the outcome changes what agents do. Two layers,
you need BOTH:

1. **Norm injection (soft binding).** Adopted rules enter every agent's propose/code
   prompt as "THE COMMUNITY DECIDED: X — act accordingly." Same injection pipe as
   lessons.py. Agents *tend* to comply. Easy.
2. **Material stakes (hard binding).** The decision touches something real in the
   verifiable world: a shared chest agents deposit to and draw from, territory,
   who gets scarce iron, where a wall goes. This is per-institution design work, not
   a generic switch — but it's what keeps governance grounded in your world instead
   of drifting into pretty-but-empty text. Start with ONE concrete stake (e.g. a
   communal storage chest) and build outward.

Grounding principle: prefer decisions whose outcomes you can SEE in the world
(where the wall gets built, whether the shared chest fills) over abstract ones
(religion, law). Verifiable consequences keep the whole system honest, the same way
inventory diffs keep task-success honest today.

### Phase 4 — Enforcement / consequence for non-compliance (optional, advanced)
Real norms have teeth. If an agent ignores an adopted norm, does anything happen?
Options, in increasing complexity: social (other agents note defection on the
blackboard → it colors future votes about that agent), material (defector loses
access to the shared chest), or role-based (repeated defection loses a
"citizenship" flag that gates participation). Only tackle once Phases 1-3 are solid.

### Phase 5 — Scale population and observe
Only now raise agent count. This is where genuine emergence appears (see Part C).
Add `goal`/`purpose` diversity so agents have reasons to disagree — a homogeneous
population has no politics. Watch `state/decisions.json` for coalitions and
norm-stability over long runs.

---

## Part B — Design considerations (the non-obvious traps)

**Spontaneity is about the trigger, not the code.** You writing a voting function
does not make it non-emergent. What makes it emergent is that the agent *chooses*
to invoke it based on its own read of the situation. Provide the affordance; never
seed the specific question or schedule the vote.

**Consequences or it's theater.** The single biggest failure mode is agents
generating plausible governance text that doesn't bind their actions. A vote on
"taxes" is meaningless unless not-paying has an effect. Always attach a material
stake you can verify.

**Belief drift.** Soft/abstract institutions (religion, ideology) produced by pure
LLM generation will evolve beautifully and also contradict themselves across cycles,
because nothing anchors a belief the way inventory anchors a fact. The lessons.py
dedup/weight mechanism is your tool for keeping an adopted norm *stable and
reinforced* rather than drifting. Verifiable/material decisions don't have this
problem — another reason to start there.

**Population floor for real politics.** At 2 agents a "vote" is agreement or
override — no coalitions, no persuasion, no factions. Honest thresholds:
- 2-3 agents: good for DEBUGGING the mechanism; politically trivial.
- ~5-6 agents: floor for behavior that feels collective (non-unanimous outcomes,
  sub-groups can form).
- ~8-12 agents: genuinely interesting — factions, influence, norm competition.

**Decision cadence.** Don't run a vote every cycle — it swamps the LLMs and makes
agents do nothing but govern. Proposals should be occasional (agent-triggered) and
a voting round interrupts normal action only when one is open.

**History matters.** Keep `state/decisions.json` as the civilization's ledger.
Injecting "here's what we've decided before" into proposals is what gives the
society continuity and lets norms compound — same idea as goal_progress.json.

**Reuse what exists.** This whole layer rides on infrastructure you already have:
blackboard (communication substrate), lessons-injection (norm pipe), critic-style
JSON calls (voting), atomic file writes + locks (shared state), goal_progress
(historical continuity). The governance layer is mostly *recombination*, not new
primitives.

---

## Part C — Hardware: reaching ~10 agents "slow but not fully serial"

### The core constraint
Each model-serving endpoint processes ONE request at a time (the per-endpoint gate
that protects your API). So **system concurrency = number of model-serving
endpoints**, not number of machines per se. Agents don't think in parallel beyond
the number of endpoints; they queue.

Per agent per cycle: ~3 actor calls (propose + ~2 code attempts) + ~2 critic calls,
plus 1 vote call in a governance round. **The ACTOR (coder) model is the
bottleneck** — it's the big model, called most, and does the heavy generation. The
critic (small model) is cheap and rarely the limit.

### Society-cycle wall-time estimates (everyone acts once)
Using rough local-inference timings (actor ~12s/call, critic ~5s/call). These are
order-of-magnitude, not promises — your real numbers depend on model size, quant,
and prompt length.

| Agents | Actor+Critic endpoints | ~Society cycle time |
|-------:|:-----------------------|:--------------------|
| 2      | 1 + 1 (today)          | ~1.2 min            |
| 4      | 1 + 1                  | ~2.4 min            |
| 6      | 1 + 1                  | ~3.6 min            |
| 8      | 1 + 1                  | ~4.8 min            |
| 10     | 1 + 1 (today's HW)     | ~6 min              |
| 10     | 2 + 2                  | ~3 min              |
| 10     | 3 + 2                  | ~2 min              |
| 10     | 4 + 2                  | ~1.5 min            |

Takeaway: 10 agents *runs today* on your 1+1 setup at ~6 min/cycle. That's slow but
not broken — fine if you value progress over speed. To get "slow but not fully
serial" (agents genuinely overlapping), you add **actor-serving endpoints**.

### What "another machine or two" actually buys
The lever is actor endpoints, not machines per se — a single strong GPU box can host
2 actor endpoints if it has the VRAM. Concretely:

- **Today (V100 32GB actor + Mac 24GB critic):** 1 actor + 1 critic endpoint.
  Note the V100 box ALSO runs the Minecraft server — it's your tightest resource.
  First cheap win: **move the Minecraft server off the actor box** onto any spare
  machine (even the 16GB Mac M5, or a NUC — the MC server is light). That frees the
  V100 to do nothing but serve the actor model.

- **+1 machine (a second actor-class GPU):** gets you to 2 actor endpoints → 10
  agents at ~3 min/cycle, real overlap. This is the highest-value single addition.

- **+2 machines (or one box hosting 2 actor instances if VRAM allows):** 3 actor
  endpoints → ~2 min/cycle at 10 agents. This is the sweet spot for a 10-agent
  society that runs at a "watchable" pace.

- The critic side rarely needs scaling; 2 critic endpoints is plenty for 10 agents.

### Recommended target hardware for a ~10-agent society at a good pace
- 1 dedicated box for the Minecraft server (light; anything works).
- 2-3 actor-model endpoints. Options: 2-3 separate GPU boxes, OR fewer boxes each
  hosting multiple model instances if they have the VRAM (e.g. a 48GB+ card can
  serve two 12-24B actor instances). A smaller/faster actor model (e.g. a strong
  14-24B coder) also raises throughput and lets one box host more instances.
- 1-2 critic endpoints (small model; your Macs are fine).
- The orchestrator itself is light — it just makes HTTP calls and manages files;
  it can run anywhere, even alongside the MC server.

### Orchestrator changes needed for multi-endpoint (small)
Today llm.py has one ACTOR and one CRITIC endpoint. To use a pool:
- Turn ACTOR/CRITIC into *lists* of endpoints.
- Add a tiny load-balancer: least-busy or round-robin, respecting each endpoint's
  gate. ~30-40 lines; the per-endpoint gate we already have does the hard part.
- Everything downstream (prompts, runner, skills, lessons) is unchanged.

### Model choice note
A smaller, faster actor model dramatically improves society throughput because the
actor is the bottleneck. For 10 agents you may prefer a strong ~14-24B coder over a
35B — slightly weaker per call, but 2-3x the throughput and easier to run multiple
instances. Worth A/B testing when you scale.

---

## Suggested execution order (when ready)
1. Solidify current embodiment at 2 bots (reliable act/survive/build). ← prerequisite
2. Build Phases 1-2 (propose + vote) at 2-3 bots. Debug the mechanism cheaply.
3. Add Phase 3 norm-injection, then ONE material stake. Prove decisions bind behavior.
4. Move MC server off the actor box (free throughput win).
5. Add the llm.py endpoint pool + load-balancer.
6. Add 1-2 actor endpoints (hardware).
7. Scale agents to 6, then 10, with diverse purposes/goals. Observe decisions.json.
8. (Optional) Phase 4 enforcement, and softer institutions once civics are solid.

First real milestone to aim for: one agent, unprompted, posts a proposal about a
concrete shared question; the others vote with reasoning; the outcome is recorded
and injected into future context. That alone proves the spontaneity behaves.

---

## Workshop siting (B-lite) — IMPLEMENTED, and what was deferred

The community now has a WORKSHOP: a shared build site where infrastructure (crafting
table, furnace, chests) clusters instead of being dropped wherever a bot stands.

What was built:
- Mason is the DECIDER (config `workshop_decider: True`). He CHOOSES the site with
  his own LLM reasoning over the terrain he can see; the code only ensures the chosen
  cell is physically sane (`goodSiteHere` / `_isGoodBuildCell`). The decision is his,
  not the designer's.
- "Physics rules" (mechanical, hardcoded on purpose): shared infra cannot be placed
  in trees/foliage/on sand — a table-in-a-tree is absurd regardless of who "decided"
  it, so it's forbidden at the placement layer, like gravity.
- Non-deciders that need infra when no workshop exists SIGNAL the need (and stay
  productive) rather than founding it themselves or stalling.
- The signal ESCALATES: an unmet need ages each decider cycle and climbs in Mason's
  proposer prompt until, past `WORKSHOP_NEED_HARDEN_AT` cycles, siting it becomes the
  cycle's explicit job. Pressure rises until it binds — the decider still chooses, but
  ignoring a maxed-out demand is irrational. Establishing the site clears the need.

Deliberately DEFERRED (add when an observed need justifies it, not before):
- VOTING to relocate the workshop once sited (currently first-write-wins; a bad
  initial site is sticky).
- VOTING / rotation to CHANGE who the decider is (currently fixed to Mason via config).
- Consensus/negotiation when two bots would site it differently (currently only one
  bot has the authority, so there's no conflict to resolve).
- Workshop ZONING / layout (furnace here, chests there, building envelope). Currently
  infra just clusters adjacent; no floor plan.

These map onto the existing propose+vote governance phases above: once the vote
mechanism exists, "relocate the workshop" and "change the decider" are just proposals
like any other. That's the natural growth path — don't build the voting for the
workshop specifically; build general voting, and the workshop inherits it.
