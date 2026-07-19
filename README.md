# mc-sid — a local Voyager + Project-Sid style Minecraft agent society

> **⭐ Before doing any work on this project, read the PROJECT DIRECTION section at
> the top of `GOVERNANCE_PLAN.md`.** Short version: the goal is emergent
> *civilization* (politics, trade, currency, logical settlement), not a perfect
> tech tree. The mechanical layer (mining/crafting/survival) is PLUMBING — make it
> reliable enough to disappear, or bootstrap past it; do NOT let it become the
> project. The social layer is where the real work is, and it is no longer gated
> behind a perfect survival loop.

A society of autonomous Minecraft agents that propose their own tasks, write
Mineflayer code to carry them out, test and self-debug, judge their own results,
and save what works into a **shared** skill library — all driven by your own local
LLM boxes, no cloud API. It's a cross between *Voyager* (a single agent that grows a
skill library) and *Project Sid* (many agents forming a society).

The current run is **20 agents** across **six local model endpoints** (see below).

## The models (six endpoints, isolated per group)

Every bot is bound to an **actor** endpoint (proposes the next task, writes/debugs
Mineflayer JavaScript, names skills) and a **critic** endpoint (judges success from a
before/after game-state diff). Bindings are per-bot and thread-local, so the boxes run
as **isolated groups**: a slow machine only stalls the ~4 bots bound to it, never the
whole society.

| id | server | model | role |
|----|--------|-------|------|
| `actor`  | llama.cpp | Qwen (32B) | actor for the original 4 bots |
| `critic` | llama.cpp | Gemma (12B) | critic for the original 4 bots |
| `qwen_a` | vLLM | qwen3.6-35b | actor **+ self-critic** for its 4 bots |
| `qwen_b` | vLLM | qwen3.6-35b | actor **+ self-critic** for its 4 bots |
| `qwen_c` | vLLM | qwen3.6-35b | actor **+ self-critic** for its 4 bots |
| `qwen_d` | vLLM | qwen3.6-35b | actor **+ self-critic** for its 4 bots |

Judging is much easier than coding, so a smaller critic model is fine. The four vLLM
boxes each serve BOTH roles for their own group (self-critique), keeping each group
self-contained. **Endpoint addresses and API tokens live in `orchestrator/local_settings.py`
(git-ignored)** — see Setup. `llm.py` sends the llama.cpp-only `reasoning_budget` to
llama.cpp boxes only, and uses `chat_template_kwargs.enable_thinking:false` (honored by
both) to keep code-gen and self-critique fast.

## The loop (one cycle, per bot)

```
observe game state
  -> ACTOR proposes a task (+ whether to reuse a known skill)
  -> reuse a working skill  OR  ACTOR writes new mineflayer code
  -> Node bot executes it, captures result + before/after snapshot
  -> CRITIC judges success from the state diff
  -> success? name it + save/reuse in the shared skill library
     fail?    feed the error back and retry (up to MAX_RETRIES)
```

Each bot runs this loop in its own thread with its own Node/Mineflayer process, so all
20 act in parallel. Working skills accumulate in `skills/working/*.js` (indexed in
`skills/skill_manifest.json`); community memory is shared via `state/blackboard.json`
and the structures registry.

## The 20 agents and their roles

The original 4 (Mason = city builder & workshop decider, Garrick = protector,
Flint = gatherer, Rowan = farmer) stay on the `actor`/`critic` endpoints. The 16 new
bots split across the four vLLM boxes, 4 per box, with roles spread so losing any one
box degrades every function a little rather than removing a whole role:

- **3 builders**, **3 collectors**, **2 farmers** — the core economy.
- **1 decorator** — beautifies the settlement without breaking function.
- **2 defenders** — light/wall/patrol now; long-term goal of raising iron golems.
- **1 explorer** — scouts terrain/resources/threats and reports to the blackboard.
- **4 floaters** — no fixed role; each cycle they read unmet community needs (open
  village-plan jobs, unmet requests, things others struggled with) and self-assign the
  most useful job. "Good citizens."

Change a bot's box or role by editing its entry in `config.py` (`actor_endpoint` /
`critic_endpoint` and `purpose`/`goal`). `python3 setup_check.py` pings every box and
prints which bots each one serves.

## Building across cycles: persistent, LLM-authored designs

Multi-cycle builds used to drift because coordinates were re-derived from scratch each
cycle. Now a builder authors a **design** once — the explicit list of `{x,y,z}` blocks
the structure is made of, with a self-review against its purpose — and the system
**persists and verifies** it in the world each cycle (`helpers.verifyCells`), handing
the coder only the still-missing cells until the structure is whole. The LLM decides the
entire shape; the system only remembers and checks it (no hardcoded blueprints). The
proposer emits `build_intent` + an optional `design_id` to continue an unfinished one.
Toggle the whole feature with `config.ENABLE_PERSISTENT_DESIGNS`.

## Self-improvement: how the society gets smarter without you editing prompts

Three layers reduce the "fix a prompt after every failure" treadmill:

1. **Seeded hazards** (`prompts.py` → `SEEDED_HAZARDS`): a one-time, editable list of
   the *predictable* ways a survival agent traps or kills itself (digging straight down,
   drowning, lava, falling, starving, floating builds). General principles injected into
   every code prompt.
2. **Self-authored lessons** (`lessons.py` + `state/lessons.json`): when a bot gives up
   on a task, it distills a short, GENERAL lesson from its failed attempts, stored and
   injected into every future prompt for **all** bots. A mistake made once becomes
   permanent shared knowledge. Lessons dedupe by similarity and are capped to stay
   high-signal. (This failure-memory is the piece Voyager lacked — it's what lets
   capability compound over long runs.)
3. **A shared skill library that consolidates** (`skills.py`): a success is saved once
   and reused by everyone. Skills are indexed by a world-agnostic **behavior signature**
   (derived from the skill's name, never coordinates), so the same behavior learned by
   any bot in any world resolves to one skill — no duplicate `craft_sticks` variants.
   Skills track success/fail; one that starts failing is REVISED in place, and if it
   still can't work, retired.

`MAX_CYCLES` defaults to 100000 so this machinery has runway — the payoff compounds well
into a long run, not early. Thinking (LLM reasoning traces) is **off by default** for
speed; enable it for specific request types by adding their label to `THINKING_LABELS`
in `llm.py` (reserved for the future societal-decision layer — governance, taxes,
disputes — not everyday block placement).

### Watching it learn
- `state/lessons.json` — society-wide lessons, growing from failures
- `state/goal_progress.json` — each bot's long-term project journal
- `skills/skill_manifest.json` — skills with reliability + revision counts
- `logs/<bot>.log` — look for `📚 learned lesson`, `🧱 design … progress`, `reused
  existing skill`, `promoted new skill`

## Long-term goals

Each bot holds a concrete standing ambition in its `goal` (config.py) — Mason: build a
stone village center; a defender: make the settlement self-defending with iron golems.
Every cycle the proposer sees the goal AND the bot's progress so far
(`state/goal_progress.json`) and picks the next small step toward it, so behavior reads
as "slowly working toward this" rather than unrelated tasks.

## Layout

```
orchestrator/            Python — the brain
  config.py              server, bots (identity/purpose/goal/endpoints), loop params  <- EDIT THIS
  local_settings.py      API tokens + endpoint URLs (git-ignored; you create this)   <- SECRETS
  local_settings_example.py   template to copy from
  llm.py                 endpoint registry, per-thread binding, thinking policy
  prompts.py             propose / code / design / name / critic prompts
  skills.py              shared skill library (behavior-signature dedup, revise/retire)
  structures.py          shared registry: workshop, village plan, persistent designs
  goals.py               per-bot long-term goal progress
  lessons.py             shared failure-memory
  capabilities.py        tracks which task-types currently work / are blocked
  stuckloop.py           detects drift/repeat loops and injects pattern-breaks
  store.py               SQLite-backed blackboard + key/value (WAL, per-thread conn)
  bot_bridge.py          manages each bot's Node process (stdio JSON RPC)
  runner.py              the multi-bot Voyager loop  <- RUN THIS
node_host/
  bot_host.js            long-lived Mineflayer bot + tested helpers; runs generated code
  package.json
skills/working/          verified skills land here (shared by all bots)
state/                   blackboard, structures, lessons, goals, capabilities
logs/                    per-bot logs
setup_check.py           verifies deps + pings every endpoint
```

## Setup

1. **Minecraft server.** Run a vanilla server the bots can reach. For no-login testing
   set `online-mode=false` in `server.properties` and use `MC_AUTH="offline"`. With 20
   bots, give the server enough RAM and set a generous `max-players`/view distance.
   Set difficulty to `easy` so the protector/defender roles have threats to handle.
2. **Node deps:** `cd node_host && npm install`
3. **Python deps:** `pip install requests`
4. **Secrets/endpoints:** `cp orchestrator/local_settings_example.py orchestrator/local_settings.py`
   then edit it with your real API tokens, box URLs, and served-model names.
   (`local_settings.py` is git-ignored — never commit it.)
5. **Point config at your server + tune bots.** Edit `orchestrator/config.py`
   (`MC_HOST`, `MC_PORT`, `MC_AUTH`, and each bot's `purpose`/`goal`/endpoints).
6. **Verify:** `python3 setup_check.py` — checks node/python deps and pings all six
   endpoints, reporting which bots each serves.

## Run

```bash
cd orchestrator && python3 runner.py
```

Watch the per-bot logs in `logs/`. Skills appear/consolidate in `skills/working/` as
agents succeed. Ctrl-C to stop; the skill library, lessons, goals, and structures
persist across runs — knowledge is kept between runs, so a fresh run starts already
knowing HOW to do things and only has to re-earn the world's goods. To start clean while
keeping learned knowledge, clear the world clutter and the runtime state in `state/`
(the blackboard/DB) but leave `skills/` and `state/lessons.json` intact.

## Tuning (in config.py unless noted)

- `MAX_CYCLES`, `MAX_RETRIES` (self-debug attempts per task)
- `PAUSE_BETWEEN` (per-bot throttle) and `STAGGER_SECONDS` (per-group startup stagger)
  so your local GPUs breathe; a per-box concurrency gate lives in `llm.py`
- `CONFIDENCE_TO_PROMOTE` (critic confidence needed to save a skill)
- `SKILL_TIMEOUT_MS`, `MAX_SKILL_REVISIONS`
- `ENABLE_PERSISTENT_DESIGNS` (kill switch for the build-design system)
- `THINKING_LABELS` in `llm.py` (which request types use LLM reasoning; empty = all fast)

## Gotchas

- Generated code runs via `AsyncFunction` inside the bot process — **not** a hardened
  sandbox. Fine for a local, trusted experiment; don't point it at an untrusted model or
  a production server.
- If the critic is too lenient/strict, tune `CRITIC_SYSTEM` in `prompts.py` and
  `CONFIDENCE_TO_PROMOTE`. The JSON/code extractors in `llm.py` already tolerate prose +
  code fences; if a model is very chatty, lower its temperature.
- 20 offline-mode bots on one server is real load — watch server TPS, and keep the base
  off water (bots path around liquid, but a waterside spawn still causes trouble).

## Project history

This README describes the system as it stands now. The full, dated evolution — every
mechanical fix (holes, crafting chain, placement, water), the scale-up to 20 bots and
six endpoints, the persistent-design system, the skill-dedup, and the secrets
externalization — lives in **`CHANGELOG.md`** (newest first).
