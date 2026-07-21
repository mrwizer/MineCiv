# Changelog

Human-readable history of changes to mc-sid. Newest entries first. This tracks
*how the system got here*; the README tracks *how it currently works*. One entry
per working session. Machine state (`skills/skill_manifest.json`, `state/*.json`)
is NOT tracked here — that gets wiped on a clean-slate reset, not documented.

Format per entry: date, one-line summary, then What / Why / Files / Verified /
Still unverified. Keep the "Still unverified" notes — they're the first place to
look if the next run misbehaves.

---

## 2026-07-20 — v23: shrink LLM prompts ~40% (state + CODE_CONTRACT + hazards) and add per-call-type token logging

Prompts had grown to ~9k+ tokens each, and on the single V100 actor box the prefill of
that much context was a real slice of per-cycle latency (plus it crowded the KV cache).
This session trims prompt size without removing any information the model actually uses,
and adds visibility so the effect is measurable rather than guessed.

### What

**#1 — Slim the game state in actor prompts.** The raw snapshot was serialized with
`json.dumps(state, indent=2)`. The single worst offender was `spatialMap.surfaceHeights`
— an 11×11 int matrix that `indent=2` explodes onto ~130 lines (~500–800 tokens) for a
grid the coder is explicitly told NOT to do math on (it uses `helpers.groundY()`); the
ASCII `grid` already gives spatial sense, and the critic already stripped it for the same
reason. New `slim_state()` / `state_json()` / `compact_json()` helpers drop
`surfaceHeights` + the redundant `spatialMap.note`, filter zero-count inventory, and
switch to compact (no-indent) JSON. Applied to the propose, code, and design prompts
(design keeps `surfaceHeights` — it anchors structures to real ground). Observed:
`strategy` prompts fell from ~9k to ~5k tokens.

**#2 — Compress `CODE_CONTRACT`.** The helper contract in every code-gen + revise call
was 5,553 tokens of verbose per-helper prose. Rewrote it to keep EVERY helper signature,
return shape, and behavioral warning (trust `collected`, `acquireStone` won't dig down,
never math on `surfaceHeights`, workshop protocol, etc.) but cut redundant examples and
filler → **3,183 tokens (~2,370 saved per call)**. Helper-name diff vs HEAD confirms no
helper was dropped.

**#3 — Compress `SEEDED_HAZARDS`.** Same treatment: all 13 distinct survival principles
kept, wording tightened → 525 → 384 tokens.

**#4 — Cap blackboard notes 30 → 15** (`BLACKBOARD_NOTES`) in `read_blackboard()`.
Most-recent only; live coordination is in the newest notes, older ones are stale.

**#5 — Per-call-type token accounting.** `_chat()` now estimates prompt tokens
(~4 chars/token) once per call and records them per label; `stats_by_label()` prints
`~N ptok` alongside timing, e.g. `code-gen: 7x 40s avg, ~8097 ptok`. This is what makes
the trims measurable live. Also removed a broken debug stub in `run_cycle` (left by an
earlier edit) that called `prompts.propose_prompt(...)` with a literal `...` and an
undefined `estimate_tokens` — it would have thrown every cycle if reached.

**#6 — Cap answer length per call type (`MAX_TOKENS_BY_LABEL` in `llm.py`).** A
before/after run proved the prompt trims cut `code-gen` from ~8k → ~5.6k ptok but did
NOT reduce latency — because latency is GENERATION-bound, not prefill-bound: prefill of
5.6k tokens is ~9s at ~600 tok/s, but the slow calls were 55–66s, i.e. ~1.6k generated
tokens at a contended ~30 tok/s. The old blanket `max_tokens=2048` let code-gen ramble
5× past the "<25 lines / ~1500 chars" contract (the 5k-char prose-in-code outputs that
syntax-errored anyway). Capped: code-gen/revise-code/strategy → 1024, naming/lesson →
512, design → 2048 (large cell lists). This truncates the SLOW tail without cutting
legitimate output. Thinking is already off for these labels, so no reasoning trace is
affected.

**#7 — Temperature ramp on code-gen.** ~Half of code-gen failures were SYNTAX errors
(`Unexpected identifier 'Oak'`/`'Need'`/`'previous'`) — sampling noise, not bad plans —
and each triggers a second ~40s retry generation, the single biggest hidden GPU-load
multiplier. First attempt now runs near-deterministic (`temperature=0.3`) for maximum
parseable code; retries climb (0.52 → 0.74) so a known-broken approach explores a
different one (matching the existing escalation text). Cleaner first attempts = fewer
retries = less generation on the shared box. `code-gen` call site in `run_cycle`.

**#8 — Fix failure misclassification that let broken saved skills survive forever
(`_looks_like_code_defect` in `runner.py`).** `is_environmental_failure` ORs together
logs + error + critic reason and text-matches env markers, so an incidental log line
like "Coal not found" (matches the `not found` marker) flipped a genuine crash such as
`Assignment to constant variable` into "environmental." An environmental verdict means
the skill is never penalized/revised/retired — so a structurally broken skill
(`deposit_or_gather`, `mine_cobblestone`) got reused and crashed EVERY cycle, burning a
full code-execute (and often retry) each time. Added `_CODE_DEFECT_MARKERS` (JS
syntax/reference/type-error signatures) checked against the thrown ERROR/stack only —
never the logs — which overrides the env markers. Genuine crashes now count against the
skill and trigger revision/retirement; real environmental failures (timeout, path
changed, no reachable stone) and the explicit host `env_failure` flag are unaffected.
Verified with 7 unit cases (the two real crashes from the run → code; timeout/goal-
changed/no-stone/host-flag → environmental).

**#9 — Fix the build-stuck-at-0/N bug: block-name canonicalization + build
diagnostics.** Root cause of Mason burning ~10 cycles unable to place ONE cell: a
persistent design authored with `block:"oak_plank"` (singular — a classic LLM error, the
real item is `oak_planks`). `buildBlocks`, `placeAt`, and `verifyCells` all match names
EXACTLY, and unlike `craftItem` they did NO normalization — so `buildBlocks` reported
`no_material` "no oak_plank in inventory" DESPITE 50 oak_planks, AND `verifyCells` never
matched the placed block, so the design sat at `0/1` forever (double failure). Added a
shared `helpers.canonicalItemName()` (singular→plural, common aliases like `cobble`/
`wooden_planks`, trailing-`s` toggle, real names pass through unchanged, no species swap
that would desync build-vs-verify) and applied it at the top of all three helpers — so
the fix is retroactive for already-stored bad designs (normalization is at read time).
Also added an orchestrator-side BUILD DIAGNOSTIC: when a build places nothing, the log
now surfaces `buildBlocks`' structured `status` + per-cell failure reasons (previously
we only saw whatever the model chose to log — often an empty summary, which is exactly
how this bug hid). Verified: `canonicalItemName` unit-tested (13 cases: singular/plural,
aliases, valid-name passthrough, unknown passthrough); `node --check` + `py_compile`.

**#10 — Undo the over-tight code-gen cap (truncation → syntax errors) + robust
extraction.** The live run confirmed #9's name fix (Mason's design now reports "already
complete (1/1)"), but exposed that #6's `max_tokens=1024` was TOO tight for this model:
it writes verbose bodies (hand-rolled loops + prose) that ran ~900–950 code tokens plus
preamble, so the cap guillotined the code mid-statement → `Unexpected end of input`
syntax errors (3× in one short run) → a wasted ~45s generation AND a retry. Raised
code-gen/revise-code to 1536 (fits verbose-but-valid output, still caps a true runaway);
a truncation-retry is pure waste so this REDUCES work. Also hardened `extract_code`: an
unclosed/truncated ``` fence now yields the code after the opener (not the prose
preamble + stray fence marker, which was itself a syntax error). Verified with unit
cases (closed fence, truncated fence, no fence).

**#11 — Prep the actor box for a coder model (Qwen2.5-Coder-32B-Instruct).** The
remaining code-gen failures (prose-in-code, ignoring `buildBlocks`, syntax slips) are the
signature of a 3B-active MoE *reasoning* model doing code with thinking off — its planning
leaks into the answer as prose. Switching the actor box to a dense CODE model addresses
the cause. Code changes to support it: (a) endpoints now carry a `reasoning` flag
(defaults True, so Qwen3/Gemma are unchanged); the actor endpoint is marked
`reasoning:False`, and `_chat` only sends the Qwen3-only thinking fields
(`enable_thinking` / `reasoning_budget`) to reasoning endpoints — a coder template lacks
those keys and can 400 on them. (b) The code-gen temperature ramp is retuned for a coder:
0.2 → 0.35 → 0.5 (was 0.3 → 0.52 → 0.74) — coders emit the most correct JS near-greedy.
Server/config side (operator notes, not code): serve a GGUF (the downloaded weights are
safetensors — convert or fetch a prebuilt GGUF); dense 32B needs `-c 32768` not `65536`
(64k KV would OOM a 32GB V100) plus `-ctk q8_0 -ctv q8_0`; the `-a` served-model name must
match `local_settings.ACTOR_MODEL` (`qwen2.5-32b-instruct`).

**#12 — Role-split topology: Hands / Judge / Mind across three machines.** Replaced the
old per-bot-group binding (4 vLLM boxes, 4 bots each) with a ROLE split, because the two
cognitive jobs have opposite needs: code-gen is frequent + mechanical + latency-critical;
strategy is rare + smart + latency-tolerant. New layout, all 20 bots sharing it:
- **Hands** — V100 llama.cpp `qwen2.5-coder-14b` (`ACTOR`, `reasoning:False`): `code-gen`,
  `revise-code`, `naming`. Fast, dedicated to the hot path.
- **Judge** — Mac llama.cpp `qwen3.5-9b` (`CRITIC`, `reasoning:True` + `critic_think:False`):
  `critic`. Reasoning model doing a judgment task, thinking off so it emits JSON directly
  (fixes the Gemma "no JSON found" parse failures) — replaces Gemma.
- **Mind** — single DGX vLLM `Intel/Qwen3.5-122B-A10B-int4-AutoRound` (`STRATEGIST`,
  `reasoning:True`, `concurrency:8`): `strategy`, `strategy-retry`, `design`, `lesson`,
  + future `governance`/`policy`/`dispute`/`trade`. ONE coherent strategic mind shared by
  ALL bots via label routing (`STRATEGIST_LABELS` / `_actor_ep_for`), not per-bot binding.
Thinking is now ON for the strategy/design/society labels (`THINKING_LABELS`) — affordable
at last because it runs on the dedicated DGX, not the shared V100, and those calls are
rare. `design` reasoning should also improve structural coherence (the `no_support`
floating-wall failures). Config: all 16 group bots repointed to `actor`/`critic`; the 4
`qwen_*` endpoints removed; `local_settings` gains `DGX_URL`/`DGX_MODEL`, drops the QWEN
fields; `--debug` now runs the first `DEBUG_BOT_COUNT` (4) bots instead of an
endpoint-type filter (moot now that all bots share boxes). Verified: all files compile;
routing resolves (mechanical→V100, reasoning→DGX-with-thinking, lesson→DGX-no-thinking);
all 20 bots bind `(actor, critic)`.

**#13 — Revert thinking-on-strategy (it caused multi-minute stalls) + empty-completion
diagnostic.** #12 turned thinking ON for `strategy`/`design` on the DGX. Live result: on
the 122B-A10B at ~20 t/s effective, a thinking call ran to the 6000-token cap = 220-280s,
blew past the 300s TIMEOUT, and RETRIED — a 5-to-15-minute stall per strategy call.
Reverted: `THINKING_LABELS` now holds only FUTURE society labels (governance/policy/
dispute/trade) that don't fire yet, so strategy/design run WITHOUT a trace (~15-40s, still
far smarter than the old model). Lesson recorded in the comment: don't enable a thinking
label unless the box can think in tens of seconds or the trace is bounded. Separately,
added a `_chat` diagnostic that distinguishes an EMPTY-AFTER-STRIP answer (model emitted
an unterminated `<think>` that `_strip_think` removed → the coder shouldn't be doing that)
from an EMPTY COMPLETION (server returned no content, logs `finish_reason`/`max_tokens`),
to root-cause the recurring `0 chars` code-gen. Verified: `strategy`/`design` no longer
think; files compile.

**#14 — Root-cause the `0 chars` code-gen: the coder was thinking.** The empty-completion
diagnostic showed `finish=length` + empty `content` + a full 1536-token generation on
complex (design-build) prompts — the signature of output routed into `reasoning_content`
(an unclosed `<think>` trace). The Qwen2.5-Coder GGUF's chat template DOES support
thinking, and because the actor was marked `reasoning:False` we were SKIPPING the
`enable_thinking:False` control — so nothing suppressed the trace, and on long prompts it
filled the whole budget without ever emitting code. Fix: actor `reasoning:True` so
code-gen (not a THINKING_LABEL) sends `enable_thinking:False`, keeping the answer in
`content`. Also: `_chat` now salvages `reasoning_content` when `content` is empty (safety
net + it logs the advice to start the coder's llama-server with `--reasoning-format
none`). This only surfaced now because the earlier MoE actor didn't have a thinking
template; the switch to a Coder GGUF with one exposed it.

### Why

Net effect: a code-gen prompt drops from ~9.7k to ~5.6k tokens (~40%) and a strategy
prompt from ~9k to ~4.6k — lowering cost and KV-cache pressure (more prompts stay
cached) — with no loss of helper capability, hazard coverage, or game state the model
uses. The prompt trims alone did NOT move wall-clock latency (generation dominates under
4-bot contention on the single V100); the #6 answer-length caps are the actual latency
lever, expected to roughly halve the 55–66s slow code-gen tail.

### Files
`orchestrator/prompts.py` (`slim_state`/`state_json`/`compact_json`; propose/code/design
state serialization; compressed `CODE_CONTRACT` + `SEEDED_HAZARDS`), `orchestrator/llm.py`
(`_est_prompt_tokens`, `ptoks` in `_bump_label`/`_chat`/`stats_by_label`;
`MAX_TOKENS_BY_LABEL` answer-length caps in `actor()`), `orchestrator/runner.py`
(`BLACKBOARD_NOTES`, removed broken token-logging stub).

### Verified
`py_compile` on all three files. Measured before/after token counts: `CODE_CONTRACT`
5,553 → 3,183, `SEEDED_HAZARDS` 525 → 384. Helper-name diff (`helpers.<name>` set) vs
HEAD is identical (the two apparent diffs are `anyPlanksInInventory`, still on its
signature line unprefixed, and `nearbyBlockCensus`, a don't-invent negative example — no
real helper lost). A live `--debug` run after change #1 showed `strategy` prompts at
~5k ptok (down from ~9k) via the new `by-type` log line.

### Still unverified
#1–#4 confirmed live (`code-gen` ~5.6k ptok, `strategy` ~5.1k). #6 confirmed to kill the
55–66s runaway tail (max slow call 66s → 49s) but the code-gen MEDIAN stayed ~36s —
because at 4-bot contention on one V100 even a 1024-token generation is ~38s; latency is
GPU-throughput-bound, not prefill- or cap-bound. `-np 2` was considered and rejected: it
reslices a fixed ~120 tok/s ceiling (2 fast + 2 queued vs 4 medium), same total
throughput, so it masks rather than fixes. The real load reducers are #7 (fewer syntax
retries) and #8 (stop re-running broken skills) — both cut WORK on the box.
#7 (temp ramp) and #8 (classifier) not yet run live: watch that first-attempt syntax
errors drop and that `deposit_or_gather`/`mine_cobblestone`-style crashes now show
"revising"/"retired" instead of "not counting against it". #9 CONFIRMED live: Mason's old design reported "already complete (1/1)", and the new
"🧱 build placed nothing — status=blocked | cell reasons: no_support_neighbour" line now
surfaces real build causes. #11 CONFIRMED live with Qwen2.5-Coder-32B on the actor box:
ZERO syntax errors across a full run (was ~50% of code-gen), short clean bodies
(<1.7k chars), coherent multi-cell designs, no `enable_thinking` 400s, and #8's
classifier correctly routed an `Assignment to constant variable` crash to regeneration →
a promoted replacement skill. Cost: dense 32B is slower (code-gen ~59s avg, design ~129s,
strategy ~38s) — but with retries largely eliminated, per-successful-task wall-clock is
comparable. Generations are tiny, so a 14B coder is the likely next step to reclaim
latency at equal quality. #7 (temp ramp, now 0.2→0.35→0.5 for the coder) is moot as a
syntax-error fix since the coder swap eliminated those outright, but stays as sane
sampling policy. STILL OPEN quality items for the next session, both now made visible by
this session's diagnostics and neither about the model: (1) designs that place a wall
course with nothing under it → `no_support_neighbour` (design-authoring / build-order
issue — Mason's 5x5 walls, Garrick's first wall attempt); (2) the Gemma critic
occasionally emitting prose instead of its JSON verdict (`critic could not be parsed
twice`) — critic-side robustness. Also still open: latency (dense 32B) — try the 14B
coder — and Garrick's `oak_fence` "placement didn't stick" (fence-specific placement).

---

## 2026-07-18 — v22: cut LLM calls per cycle — skip critic on trusted work + continue builds without re-planning

Bots stood idle ~78% of the time not because of threading (they're already fully
parallel) but because each cycle makes three serial LLM round-trips (propose ≈160s
before v16, code-gen, critic ≈44s) that dwarf the actual in-world action. Two changes
remove LLM calls from the common path.

### #1 — Programmatic verdict (skip the LLM critic when we already know)
The LLM critic's real value is gating promotion of NEW skills. For work where we have a
GROUNDED success signal it's pure latency, so it's now skipped in two cases:
- a **persistent-design build** — success/failure is read directly from the world
  (`verifyCells` progress), and
- a **reused PROVEN skill** — `skills.is_proven()` (≥3 uses and more successes than
  fails); young/shaky skills still get the full LLM critic.
`_programmatic_verdict()` judges from the run: runtime error or explicit failure status
→ fail; verified design progress, a success status, or a real inventory/world change →
pass; a clean run with no measurable effect → fail (nothing credited for nothing).
Programmatic passes are tagged so they never trigger skill promotion (which would spend
an LLM naming call). New/unproven code is unaffected — it still gets the real critic.

### #2 — Continue a build without re-planning
A multi-cycle build used to spend a propose (and, pre-#1, a critic) call every cycle
just to decide to keep building the same thing. Now, when a bot has a design still
missing cells that it progressed on last cycle, the next cycle carries straight on with
it and skips the propose call entirely. Bounded so a bot can't get trapped: it re-plans
after `CONT_MAX_CYCLES` (6) in a row so survival/community needs resurface, any cycle
that fails to progress clears the continuation (a stuck build drops back to a fresh
propose that can gather/relocate/abandon), and it never overrides the stuck-loop
pattern-break path. Continuation state is grounded in the design record and threaded
through `run_bot` across cycles.

Net effect: a builder mid-structure can run several cycles with **zero** propose/critic
calls — code-gen + execute only — so the avatar is acting, not waiting. A routine gather
with a proven skill drops from three LLM calls to one (propose only). This stacks on
v16 (thinking off) and is the highest-leverage latency win short of a full
action/planning pipeline.

### Files
`orchestrator/runner.py` (`_programmatic_verdict`, `CONT_MAX_CYCLES`, continuation in
`run_cycle`/`run_bot`, verdict gate, promotion guard), `orchestrator/skills.py`
(`is_proven`).

### Verified
`py_compile` + full import; unit tests of `_programmatic_verdict` (error/blocked →
fail; design-progress/inventory/status → pass; clean-but-nothing → fail; all tagged
`_programmatic`) and `is_proven` (0 uses → no; 3-0 → yes; 3-4 → no). Behaviour to watch
live: far fewer `strategy`/critic calls per builder, `⚡ fast verdict` and `⏩ continuing
design` lines in the logs, and much less idle time per bot.

### Still unverified
Not run live. Watch that programmatic verdicts aren't masking real build failures (the
`no measurable progress → fail` guard should prevent false passes), and that the
6-cycle continuation cap keeps survival responsive.

---

## 2026-07-18 — v21: `--debug` flag to run only the llama.cpp bots (free the vLLM boxes)

Added a launch-time `--debug` flag to `runner.py`. With it, only the bots whose actor
AND critic run on llama.cpp boxes launch (the original 4 — Mason/Garrick/Flint/Rowan on
the V100 actor + Mac critic); every bot that needs a vLLM box is skipped, so those
machines are free to be repurposed for local LLM coding. Without the flag, all 20 bots
run exactly as before — no config or code change needed to switch back.

- `python runner.py` → all bots. `python runner.py --debug` → llama.cpp bots only.
  Still composes with the existing username filter (`runner.py --debug Mason`).
- The filter is by endpoint SERVER TYPE (`server != "vllm"`), not by IP, so it keeps
  working if the box addresses change in `local_settings.py`. Prints which bots it skips.
- Switched arg handling to `argparse` (adds `-h/--help`) while preserving the old bare
  `runner.py Mason Garrick` positional-username behavior.

### Files
`orchestrator/runner.py` (argparse + `_uses_only_llamacpp` + debug filter in `main()`).

### Verified
`py_compile`; `--help` renders; filter test confirms default launches all 20 and
`--debug` launches exactly the 4 llama.cpp bots, skipping the 16 vLLM bots.

---

## 2026-07-18 — v20: bring the README up to date

The README still described the original setup — "two local Unsloth Studio machines"
(V100 + Mac M4) running one bot — and had grown a long v3–v13 version-by-version tail
that duplicated this CHANGELOG. Rewrote it to describe the system as it stands: 20 agents
across six endpoints (actor + critic + four vLLM boxes, isolated per group,
self-critique), the role breakdown, persistent build designs, the shared
behavior-signature skill library, thinking-off-by-default, the `local_settings.py`
secrets setup, and a current file layout. The redundant per-version history was replaced
by a pointer to this CHANGELOG. No code changes. Also removed a stale reference to a
`reset_run.py` helper that doesn't exist in the repo.

---

## 2026-07-18 — v19: externalize secrets + scrub identifiers for a public repo

Prep for publishing to a public GitHub repo. All tokens and box addresses moved out of
the committed source into a single git-ignored file; no secrets or private network
details remain in anything that gets pushed.

- **`orchestrator/local_settings.py`** (NEW, git-ignored) — holds the real API tokens,
  endpoint URLs, and served-model names. This is the only file with secrets; it is
  listed in `.gitignore` and must never be committed.
- **`orchestrator/local_settings_example.py`** (NEW, committed) — placeholder template.
  Setup on a new machine: `cp orchestrator/local_settings_example.py orchestrator/local_settings.py`
  then fill in real values.
- **`llm.py`** now imports endpoints/keys from `local_settings`; on a fresh checkout
  where that file doesn't exist yet it falls back to the example placeholders and prints
  a one-line warning, so the code still imports without crashing.
- **`.gitignore`** (NEW) — excludes `local_settings.py`, `.env`/`*.secret*`, Python
  caches, `node_modules/`, run logs, and the SQLite state DB.
- **Scrubbed** the two real API tokens and all private LAN IPs (192.168.x.x) from every
  committed file — `llm.py`, `config.py`, `README.md`, and this CHANGELOG's history now
  use placeholders (`ACTOR_HOST`, `VLLM_HOST_1`, `<your-api-token>`, …). Remaining
  "Unsloth"/"vLLM" mentions are just the names of the (public) serving software, not
  identifying info. No emails, usernames, home paths, or hostnames were present in the
  repo files.

### Verified
`git check-ignore` confirms `local_settings.py` is IGNORED and `local_settings_example.py`
is committable; a simulated fresh clone (no `local_settings.py`) imports `llm.py` via the
placeholder fallback without crashing; a full-tree grep finds no tokens or private IPs
outside the git-ignored `local_settings.py`.

### Before you push
Run `git status` and confirm `orchestrator/local_settings.py` is NOT listed (it should be
ignored). If you ever committed a token earlier in this repo's history, rotate it — git
history preserves old commits even after a file is removed.

---

## 2026-07-18 — v18: stop duplicate skills — one behavior, learned once, shared by all, in any world

The library had ballooned to ~440 working skills: 12+ `craft_sticks`, 20 `plant_wheat`,
19 `deposit_cobblestone`, etc. Cause: `promote()` only deduped against a 5-entry
`FROZEN` whitelist (with a never-finished "add the rest of your 19 slugs" TODO), so
every behavior outside those 5 spawned a new file — and a slug collision appended a
timestamp (`_1783…`) rather than reusing. With 20 bots each learning the same basics
under LLM-varied names, the same behavior became a dozen files. This fragmented the
shared learning (12 skills with 1 use each instead of one with a real track record)
and bloated retrieval.

Fix: a general, world-agnostic **behavior signature**. `promote()` now reduces a skill
NAME to the set of meaningful action/object tokens and, if a non-retired skill with the
same signature already exists, REUSES it (returns its slug, writes no file) instead of
duplicating — picking the most-reliable variant when the messy existing library has
several. The signature is derived ONLY from the name, never from coordinates or world
state, so the same behavior has the same identity in ANY world and across restarts —
knowledge is learned once and shared by the whole society, exactly the design intent.
- Timestamps/counts, wood SPECIES (oak/birch…), and LOCATION/direction qualifiers
  (near/at/workshop/north…) are stripped, so `craft_sticks`, `craft_sticks_from_oak`,
  `craft_sticks_1783…` and `craft_oak_planks`/`craft_birch_planks` collapse to one.
- Tool TIERS (wooden/stone/iron) and object nouns are KEPT, so genuinely different
  skills (stone vs wooden pickaxe; deposit cobblestone vs logs; plant wheat vs potato)
  stay separate. Conservative by design: it won't over-merge.
- Existing entries (no stored signature) get one derived from their slug on the fly, so
  new promotes dedup against the current library immediately — growth stops now, and
  future reuse consolidates onto existing skills. (Existing duplicates are left in place
  for the operator to curate later; nothing is deleted.)
- `promote()` now returns `(slug, created)`; the runner logs "reused existing skill …
  (no duplicate created)" vs "promoted new skill", so the consolidation is visible.

### Files
`orchestrator/skills.py` (`_behavior_sig`/`_stem`/`_sig_of_meta`, signature dedup in
`promote()`), `orchestrator/runner.py` (unpack `(slug, created)`, honest log).

### Verified
`py_compile` both; a sandboxed functional test: 9 promotes of overlapping behaviors →
5 files, with species/direction/location/timestamp variants reused and tool-tier/object
differences kept distinct.

---

## 2026-07-18 — v17: fix the execution collapse (11% task success) — water, congestion, siting, capability amputation

A 20-bot, ~2.5h run had an **11% task success rate** (154 ok / 1262 fail). Diagnosis
from the logs: the PROMPTS are fine — the proposer picks sensible tasks — but the
mechanical EXECUTION layer fails ~89% of the time, so nothing compounds and no
community forms. Four mechanical causes, fixed here:

1. **Water/drowning cascade (604 drownings → 577 "goal was changed").** Each drowning
   makes the watchdog null the running skill's path goal, killing the skill. Root: the
   base sat on/near water and bots kept stepping in. `moves.liquidCost` 60 → **120** so
   any dry detour beats a single water step, AND build-site validation now rejects
   liquid sites (below).
2. **Congestion — 20 bots stacked on ONE shared crafting table** (64 "craft window did
   not open", 121 "could not path within reach"; the operator's "blocking each other in
   a hole"). The old craft policy walked every bot to the single workshop table.
   `craftItem` now PLACES ITS OWN disposable table where it stands when none is within
   reach, instead of pilgrimaging to the shared one. Chests/furnaces stay shared.
3. **Bad siting / "random structures."** `_isGoodBuildCell` now rejects cells that are
   liquid, sit on liquid, or have 2+ liquid neighbours — so the workshop and every
   build land on dry, solid ground instead of a flooding shoreline. This also cuts (1).
4. **Capability amputation (393 capabilities BLOCKED in one run).** `run_cycle` recorded
   a capability FAILURE on every give-up regardless of cause, so transient
   water/path/congestion failures permanently blocked whole capabilities (mine, craft,
   build…), shrinking the action space until bots could do almost nothing. Now a give-up
   only counts against a capability when at least one attempt was a genuine code failure
   (`not cycle_all_env`); purely environmental wipes are a wash.

Note: pathfinder-interruption errors ("goal was changed", "path was stopped",
"timed out") were already classified transient (no bogus skill-rewrite), so #1's
residual is handled by cutting the drowning that causes it, not by touching the
watchdog (which is correct and left alone).

### Files
`node_host/bot_host.js` (liquidCost 120; `_isGoodBuildCell` liquid rejection; local
crafting-table placement), `orchestrator/runner.py` (env-only failures don't block
capabilities).

### Verified
`node --check` on bot_host.js, `py_compile` on runner.py. All four edits present.

### Still unverified (no live server here)
These are logic fixes validated by reading, not a live run. Next run, watch: drowning
events and "goal was changed" should fall sharply; "craft window did not open" should
drop as bots stop stacking; capabilities-BLOCKED count should be a fraction of 393; and
the task success rate should climb well above 11%. If drowning persists, the base site
itself is the problem — reset the run so the workshop re-sites on the now-dry-only rule.

---

## 2026-07-18 — v16: reasoning off by default (framework for later), build de-jam, critic JSON fix

A 20-bot live run showed the society looked frozen: ~95% of bots standing still. The
by-type stats explained it — `strategy` (propose) averaged **162s** and `design`
**~190s** per call because both forced `think=True`, while `code-gen` was ~34s. Three
to six minutes of every build cycle was an avatar standing still waiting on a reasoning
trace, and the vLLM boxes were saturating and timing out under that load.

### Thinking is now OFF by default, with a framework to turn it on for the right requests
- `llm.py` adds `THINKING_LABELS` (a set of request labels that reason) and
  `should_think(label)`. `actor()` now takes `think=None` and, when not told
  otherwise, reasons iff the call's LABEL is in that set. The set is **empty today**,
  so propose/design/code/critic all run fast.
- The propose ("strategy") and design calls no longer force `think=True`; they pass a
  label and let the policy decide (→ off now). Expected effect: strategy drops from
  ~160s toward code-gen's ~35s, roughly a 4–5× cut in per-cycle idle, and far less
  load/timeouts on the vLLM boxes.
- This is the hook for the future societal layer (GOVERNANCE_PLAN.md): when
  governance/taxation/dispute decisions arrive, enable deep thinking for JUST those by
  adding their labels (e.g. `THINKING_LABELS = {"governance","taxes"}`) and tagging
  those calls `label="governance"`. Everyday block-placement never pays the cost.

### Build de-jam (fixes a regression from v15's persistent designs)
The run showed builders permanently stuck: `design 'initial_shelter_floor' already
complete (0/0) — nothing to build`. A design had been authored with **zero valid
cells** (the model omitted Y coordinates, so every cell was dropped), and an empty
cell list reads as "nothing missing → complete", so that structure was marked done
forever and its builders could never build it.
- `structures.save_design` now returns None (refuses to store) when no cell has valid
  {x,y,z}. `active_design_for` and `designs_block` ignore any 0-cell record left over
  from older runs. `_prepare_design` treats `total < 1` as "not a design", only calls
  a design "complete" when it has cells AND none are missing, and falls back to the
  normal build flow when authoring yields no valid cells.
- Added `config.ENABLE_PERSISTENT_DESIGNS` (default True) as a kill switch to disable
  the whole design feature instantly and build normally, no code edits needed.

### Critic JSON fix
`critic could not be parsed twice: no JSON found` was truncation: the critic writes a
sentence of evidence, then the JSON, and at `max_tokens=256` the closing brace got cut
off. Raised the critic budget to **512** (still fits a small-context critic) and told
the critic prompt to emit ONLY the JSON, first character `{`, one-sentence reason — so
the object completes well within budget. (Propose truncation — `propose returned no
task (likely truncated reasoning)` — is addressed by thinking-off removing the long
traces that ate the budget.)

### Files
`orchestrator/llm.py` (THINKING_LABELS/should_think, actor label-driven thinking,
critic max_tokens 512), `orchestrator/runner.py` (label-driven strategy/design calls,
design de-jam guards, kill-switch gate), `orchestrator/structures.py` (reject 0-cell
designs; ignore junk), `orchestrator/prompts.py` (critic JSON-first), `config.py`
(ENABLE_PERSISTENT_DESIGNS).

### Verified
`py_compile` all; functional test confirms thinking is off by default and a label flips
it on, 0-cell designs are rejected (not marked complete) while real designs still
store/verify/complete, and the kill switch is present.

### Still unverified
Not re-run live yet. Watch that strategy/design call times drop into the tens of
seconds and that vLLM timeouts fall; confirm builders now either build real designs or
fall back cleanly instead of jamming on "0/0 complete".

---

## 2026-07-18 — v15: scale to 20 agents across isolated endpoint groups + persistent build designs

Four requests from the owner: (1) add 16 bots (20 total), (2) put them on four new
vLLM boxes, 4 per box, (3) run the boxes as ISOLATED GROUPS so one slow machine
can't drag the others down, and (4) improve building — which is still poor — without
hardcoding structure shapes (a voxel-geometry LoRA is planned but not yet done).

### What — scaling & endpoint groups (requests 1-3)
- **16 new bots (20 total).** Roles per owner: 3 builders, 3 collectors, 2 farmers,
  1 decorator, 2 defenders (with a long-term goal of raising iron golems), 1
  explorer, and 4 "floaters" with no fixed role. Distributed so losing any one box
  degrades EVERY function a little rather than removing a whole role. The original 4
  (Mason/Garrick/Flint/Rowan) are unchanged and stay on the original endpoints.
- **Four new vLLM boxes** (`qwen3.6-35b`): `…125:8000`, `…125:8001`, `…62:8002`,
  `…62:8003`, 4 bots each. Each new box serves BOTH the actor role AND self-critique
  for its own 4 bots (the Gemma critic box is already slow, so new groups are
  self-contained). All new boxes share the existing API token.
- **Per-bot, thread-local endpoint binding** (`llm.bind_endpoints`, called at the top
  of each bot's thread in `run_bot`). Every `llm.actor()/critic()` call now routes to
  the box that bot owns, with NO change to the many call sites. Unbound threads (e.g.
  `setup_check`) fall back to the original ACTOR/CRITIC, so nothing else changed.
- **Groups run independently.** The per-endpoint concurrency gate was already keyed by
  URL; binding bots to different URLs means a slow box only stalls its own ~4 threads.
  Startup **stagger is now per-group** (the k-th bot ON A BOX waits k·STAGGER; groups
  start in parallel) instead of a single global launch queue that made the 20th bot
  wait ~2.5 min. Gates honor an optional per-box `concurrency`.

### Why — vLLM vs llama.cpp is not interchangeable
The original `.128` actor is **llama.cpp** and is NOT changing. The new boxes are
**vLLM**. `_chat` now branches on an endpoint `server` field: `reasoning_budget` (a
llama.cpp field that vLLM can 400 on) is sent ONLY to llama.cpp; `enable_thinking:
false` (honored by both) turns thinking off for fast code-gen on either. Self-critique
on the new reasoning boxes runs with thinking OFF (`critic_think:false`) so it emits
its small JSON verdict instead of burning the 256-token budget on a `<think>` trace.
Gemma's critic path is byte-for-byte unchanged (no `critic_think` field).

### What — buildings (request 4), still zero hardcoded shapes
Root problem after the 07-08 physics/feedback work: each cycle the builder re-derived
a structure's coordinates from scratch, so a multi-cycle build never converged. Fix is
a **persistent, LLM-authored DESIGN**:
- The builder authors a design ONCE (`prompts.design_prompt`) — the explicit list of
  `{x,y,z}` cells the structure is made of, plus a **self-review** pass where it checks
  its own cell list against the purpose (enclosed? roofed? door? no gaps?) and fixes it
  before returning. The SHAPE is entirely the model's; we store and verify it, nothing
  more (fidelity category A/B, not C).
- Designs persist in the structures registry (`save_design`/`get_design`/
  `active_design_for`/`update_design_progress`/`designs_block`). Each build cycle the
  runner runs a new **`helpers.verifyCells`** (read-only, in-world) to see which
  designed blocks actually exist, updates progress, and hands the coder ONLY the
  still-missing cells (`code_prompt(design=…)`), so the build converges on the same
  structure and a completed design marks its plan slot built. Additive: if authoring
  fails or the task isn't a build, the normal flow runs unchanged (no regression).
- The proposer now emits `build_intent` + optional `design_id` (continue an unfinished
  design instead of starting over). This complements a future geometry LoRA rather than
  replacing it — better scaffolding + grounded feedback around whatever model runs.

### What — floaters ("good community members")
Floaters get a **community-needs block** (`structures.community_needs_block`): open
village-plan jobs, an unmet workshop need, and recent blackboard requests / things
others struggled with, minus what's already done — injected only into floaters' proposer
so they self-assign the most useful UNMET job each cycle.

### Files
- `orchestrator/config.py` — 16 new bots + roles/goals; per-bot `actor_endpoint`/
  `critic_endpoint`; endpoint-group docs; stagger reworded as per-group.
- `orchestrator/llm.py` — endpoint registry (`ENDPOINTS`, `get_endpoint`), four vLLM
  boxes, thread-local `bind_endpoints`, `server`-aware think flags, per-box gate
  concurrency, `critic_think`.
- `orchestrator/runner.py` — bind endpoints per thread; per-group stagger; design
  prep/verify/reverify helpers; `build_intent`→design flow; floater needs + designs
  passed to the proposer.
- `orchestrator/prompts.py` — `design_prompt`; `code_prompt(design=…)` directive;
  `propose_prompt` gains `community_needs`, `designs`, and `build_intent`/`design_id`.
- `orchestrator/structures.py` — persistent design storage + `community_needs_block`;
  added `import re`.
- `node_host/bot_host.js` — `helpers.verifyCells(cells, name)` (read-only design check).
- `setup_check.py` — pings every registered endpoint (deduped) and reports which bots
  each serves.

### Verified
- `py_compile` on all changed Python; `node --check` on `bot_host.js`.
- Import/wiring smoke test: all 20 bots resolve to real endpoints (4 per box), the four
  floaters are flagged, `propose_prompt`/`design_prompt`/`code_prompt` accept the new
  params, and the design store round-trips (save → progress → active-continue).

### Still unverified (no live LLMs / MC server here)
- Not run against the four vLLM boxes or a live server. Confirm `qwen3.6-35b` accepts
  `chat_template_kwargs.enable_thinking:false` and does NOT need `reasoning_budget`; run
  `python3 setup_check.py` first (it now pings all boxes).
- **Assumption:** the new boxes use the existing actor token (`<your-api-token>…`). If a
  box was started with a different `--api-key`, change `VLLM_KEY` in `llm.py` (one line).
- Whether the base `qwen3.6-35b` authors coherent cell lists is exactly what the design
  scaffolding + LoRA are meant to improve; watch `state` designs and the `🧱` log lines.
- 20 offline-mode bots on one Minecraft server is a SERVER-capacity question (view
  distance, entity/tick load), independent of this LLM work — watch server TPS.

---

## 2026-07-08 (k) — The real build bug: silent placement failures + no terrain height

Owner pushed back correctly on the previous plan. I had proposed adding structural
verbs (build_wall/roof/box). Owner's point: the LLM already has `placeAt(x,y,z,name)`
as a free primitive and skills are arbitrary JS, so it can ALREADY place blocks at
any coordinates to form any shape — it does NOT need special verbs (that would drift
toward blueprints). So why do structures still fail? Investigation found the actual
bug, which is NOT "buildLine only makes lines":

### Root cause — placeAt failed SILENTLY, so the LLM couldn't learn
- Log evidence: Mason repeatedly tried to build a shelter with planks AND doors in
  inventory, clearly knowing what it wanted — and placed ZERO blocks
  ("Δinv: (no change)", "used some oak planks but no new blocks added"). It was
  picking placement coordinates in MID-AIR (nothing adjacent to build against). In
  real Minecraft you can't place a block against empty air — placeAt correctly
  refused, but returned a BARE `false` with no reason. So the LLM never learned WHY,
  kept picking mid-air coords, and burned attempts. The scattered floating fragments
  in the screenshots are the few placements that happened to catch a side face.
- This matched the owner's diagnosis exactly: the 35B model KNOWS what a shelter is
  (it had doors ready!); it was blind to terrain heights and got no feedback, so it
  couldn't translate its correct mental model into placeable coordinates.

### Fix — all INFORMATION, no new constraints or verbs (owner's three choices)
1. placeAt now LOGS why it fails, and logs flow to the LLM: "no solid block adjacent
   — it would float in mid-air, place a supporting block first", "not in inventory",
   "couldn't path within reach", "placement didn't stick". The LLM can read this and
   self-correct instead of retrying mid-air. (Return type stays boolean — all
   existing callers unaffected; reason is logged + stashed in _lastPlaceFail.)
2. Spatial map (j) gains `surfaceHeights` — the ground Y of each column around the
   bot. Now the LLM can pick coordinates that CONNECT to terrain: place the bottom
   course at surfaceHeight+1, stack upward. No more guessing a Y and floating.
3. Build guidance rewritten: placeAt is your tool for ANY shape (not just lines);
   blocks can't float so build GROUND-UP from surfaceHeights; roofs need walls up
   first; read the failure log and fix the cause. Still zero blueprint — the LLM
   designs the shape, we just made it able to SEE and LEARN.
- Placement PHYSICS left unchanged per owner ("leave physics, fix feedback +
  visibility"). allowFloating still exists; the new no-neighbour check runs
  regardless, so even wall skills get the informative failure.

### Files
- `node_host/bot_host.js` — placeAt informative failures + `_lastPlaceFail`;
  `buildSpatialMap` adds `surfaceHeights`.
- `orchestrator/structures.py` — build guidance: placeAt-for-any-shape, ground-up,
  read-the-failure.

### Verified
- `node --check` + `ast.parse` pass. Smoke tests: map shows a wall gap as `dC@dd`;
  surfaceHeights reads 67 on flat ground and 68 at a placed block. no-neighbour log
  path confirmed reachable even with allowFloating.

### Still unverified / watch (the key test)
- Do structures now CONNECT and rise? Watch for placeAt failure logs DROPPING over a
  run (LLM learning from feedback), and blocks stacking into actual walls with height
  rather than floating single-course fragments. Screenshot.
- Does the LLM reference surfaceHeights / the failure messages in its reasoning
  ("ground is at Y=67, placing wall base at 68")? That confirms the info is used.
- Mason's "slightly higher than target Y" confusion should resolve now it can see
  ground height. If it still fights Y-coordinates, the map's origin/height framing
  may need to be clearer.
- If floating fragments PERSIST despite the no-neighbour check, then something IS
  bypassing placeAt (raw bot.placeBlock somewhere) — would need a fresh grep.
- Still no forced completion check — a bot could mark a bad structure done. Deferred.

---

## 2026-07-08 (j) — Give the LLM SPATIAL SIGHT (top-down map) so it stops building blind

Screenshots after (h)/(i): structures were floating fragments, cantilevered slabs on
single dirt pillars, walls with huge gaps that enclose nothing (image 3 clearly
TRIES to be a walled shelter but has open sides). Owner's read: "the LLM is not
thinking well on it, OR not seeing all the blocks to understand how it fits as a
whole." The second is exactly right.

### Root cause — the LLM was building BLIND
- The only world-perception it got was `nearbyBlockCensus`: a HISTOGRAM
  ({cobblestone:8, dirt:5}). Counts, ZERO spatial info — no positions, no
  arrangement, no adjacency. You cannot reason about enclosure (a spatial property)
  from a shopping list. A brilliant architect handed counts instead of a view would
  produce exactly these fragments. Not an LLM reasoning failure — a perception gap.

### Fix — raw spatial sight, NOT interpretation (owner's explicit choice)
- New `buildSpatialMap()` in bot_host.js: a compact top-down ASCII grid (radius 5 =>
  11x11) centered on the bot, each cell = the topmost block in a vertical band, with
  a legend (C=stone P=planks W=log d=dirt f=fence i=torch ~=water @=you .=air ...).
  Added to the snapshot as `spatialMap`, so it flows into the propose prompt (which
  json.dumps the whole state). Cost ~150 tokens — negligible vs the 6000-token answer
  budget; NO context-window/vLLM change needed (owner asked to be told if it did).
- Deliberately gives RAW data, no computed "you have a gap at N". Owner chose to let
  the LLM draw its OWN enclosure conclusions — computing gap-analysis ourselves would
  make US the arbiter of "enclosed" and risk debugging our analyzer instead of
  watching the builder (same trap we avoided with the critic). Verified with a smoke
  test: a 3-sided wall with a missing east block renders as `dC@dd` (gap visible) vs
  `dC@Cd` (closed) — the LLM can now SEE the hole.
- `structures.purpose_block()` extended: tells the bot to READ the map before
  building, find gaps, place blocks where the barrier is broken — and (owner's Q3)
  to only mark a slot complete once it HONESTLY serves its purpose (check the map: is
  it enclosed?), noting remaining work on the blackboard instead of declaring a
  half-structure done. No FORCED verification gate — it's the LLM's judgment call.

### Files
- `node_host/bot_host.js` — `buildSpatialMap()` + `spatialMap` in snapshot.
- `orchestrator/structures.py` — map-reading + honest-completion guidance in
  purpose_block. (prompt already json.dumps state, so the map needs no wiring.)

### Verified
- `node --check` + `ast.parse` pass. Map logic smoke-tested: correctly renders walls,
  grass, bot position, and shows a missing wall block as a visible gap.

### Still unverified / watch (this is the key experiment now)
- THE question: with spatial sight, do structures actually CLOSE UP? Watch whether
  bots place blocks INTO the gaps the map shows, and whether walls connect into an
  enclosure over several cycles. Screenshot results.
- Does the LLM reference the map in its reasoning ("the map shows an opening on the
  east side, placing cobblestone there")? If it states gaps and fills them, sight
  worked. If it has the map but still builds fragments, the gap is reasoning, not
  perception — a harder, different problem.
- The map is radius 5 (11x11) around the BOT, not around the STRUCTURE. If a bot
  builds something bigger than ~10 blocks it can't see it all at once — may need a
  structure-centered or larger map later. Watch for structures outgrowing the view.
- Floating blocks: (i) placeAt already needs a solid neighbour, but the screenshots
  predate checking whether that's actually holding — watch for cantilevered/floating
  placements; if they persist it's a separate placeAt bug.
- "Mark complete honestly" is a soft prompt nudge, not enforced. If bots still
  declare half-built things done, we'd add a real check — but that's deferred per
  owner (don't force verification yet).

---

## 2026-07-08 (i) — Fix watchdog false-drowning, farmer oscillation; split mob-damage from drowning

First run on the (h) stack. GOOD: the structure-PURPOSE goals worked — critic
verdicts now reason about FUNCTION ("closing gaps in the enclosure", "reducing the
likelihood of mob spawns", "securing the perimeter"), and Mason marked a 'shelter'
slot BUILT and is laying planks for a wooden shelter. That's the intended emergent
architectural reasoning. Success rate 25% (held despite one bot crippled). BAD: the
(g) drowning-interrupt was badly miscalibrated — 289 EMERGENCY fires — and the
shoreline oscillation returned hard (Rowan: 771 water bounces, only 34 successes vs
45-63 for the others). Root causes found in the log, both my bugs.

### Bug 1 — drowning trigger fired on ANY injury near water (289x)
- (g)'s condition was `inLiquid AND (lava OR oxy<=14 OR hp<=15)`. The `hp<=15`
  clause fired whenever a bot was HURT while in water — full oxygen (oxy=20), HP
  falling 17→14→12→7. That's a MOB attacking a bot that happens to be in water, not
  drowning; swimming did nothing about the mob, so it re-fired every tick as HP fell.
- Fix: drowning is now `lava OR (inLiquid AND oxygen < 20)` — i.e. air ACTUALLY
  being consumed. Health is no longer part of the drowning signal at all.

### Bug 2 — the watchdog was fighting the FARMER's purpose (771 bounces)
- Rowan is the farmer; its tasks are literally "till dirt adjacent to the water
  source", "plant wheat near the water". Farming REQUIRES standing at the water's
  edge. The watchdog treated any water contact as an escape trigger and dragged
  Rowan inland every tick — away from the farmland its own task needed — then the
  next farming task walked it back. Bot vs. its own role, ~2x/second.
- Fix: `reflexWater` and the cycle-blocking `_inWaterNow` now also gate on
  `oxygen < 20`. A bot standing in shallow water with full air is left completely
  alone. Only real air-loss triggers an escape or blocks a cycle. The inland-step +
  safe-ground logic now only runs after an ACTUAL escape, so the farmer is never
  pulled off its fields.

### Bug 3 (owner-requested) — mob damage is now a SEPARATE threat, handled on LAND
- Previously "hurt near water" was miscategorized as drowning (swum away from).
  Split cleanly: a MOB emergency = health actively FALLING since last tick AND a
  hostile within 8m. It can interrupt a skill too (a bot being eaten won't finish
  anyway), but responds on LAND, never by swimming.
- `reflexFlee` upgraded to FIGHT or RETREAT (owner's choice): if it has a
  sword/axe and hp>8 it equips and swings; otherwise it backs away on land. The
  interrupted skill returns env_failure (`_skillInterruptedByMob`), so it isn't
  counted as a code bug or revised.

### Files
- `node_host/bot_host.js` — oxygen-gated drowning in both the tick and reflexWater;
  `_inWaterNow` gated on drowning; `_lastHealth`/`_skillInterruptedByMob` tracking;
  unified emergency decision (fixed a dead-code path where mob-during-skill never
  ran); `reflexFlee` fight-or-retreat; mob-interrupt env_failure in runSkill.

### Verified
- `node --check` passes. Oxygen gate present in both spots; mob-interrupt wired in 5
  places; fight+retreat branches present. Traced the unified emergency block — mob
  path is now reachable during a skill (was dead code in the first draft).

### Still unverified / watch (next run)
- THE KEY CHECK: Rowan's water-entry count should collapse from 771 to near-0, and
  its success count should rise toward the others' (was 34 vs 45-63). If it still
  oscillates, the farmer is entering water deep enough to lose air (oxy<20) while
  farming — in which case farming tasks themselves are choosing bad (deep) spots and
  the fix belongs in the farm-site choice, not the watchdog.
- Confirm the 289 false "drowning" emergencies are gone (should only fire on real
  air loss / lava now).
- NEW behavior to watch: does reflexFlee actually help vs mobs, or do bots die
  anyway? This is the first real mob-defense logic — watch mob-death frequency.
- Keep watching the PURPOSE goals (h): do shelters actually get enclosed + roofed
  now, or do bots state the goal but still build open walls? Screenshot results.
- Success was 25% with a crippled Rowan; if the fix frees Rowan, expect it to rise.

---

## 2026-07-08 (h) — Give structures a PURPOSE (goal-framed, not blueprints)

Strategy shift, not a bug fix. Screenshots showed Mason's "building": a couple of
pillars, a chest, a torch — enclosing nothing, no roof, no door, no protection. It
got marked BUILT because the system only ever knew WHO builds WHERE (workshop siting,
plan slots, claim/complete), never what a building is FOR. `structures.py` had zero
concept of roof/enclosure/door/protection — a slot was just {id,name,kind,pos}.

Owner's design choices (deliberate, to preserve the experiment):
- FUNCTION, not FORM. Do NOT hand the LLM a blueprint ("5x5, walls height 3, roof").
  That would reproduce OUR idea of a building. Instead state the GOALS a structure
  serves ("keep mobs out", "keep the elements out", "safe place to sleep") and watch
  what the LLM independently decides achieves them. Unexpected-but-functional = a
  finding, not a bug.
- Critic does NOT judge structures. Grading enclosure/roof/pathing from a block
  census is a hard geometry problem a small critic would get wrong constantly —
  we'd end up debugging the judge, not watching the builder (the same trap as the
  old quantity-critic). The HUMAN eyes the results; the intelligence goes into the
  GOAL we give the builder, not into an automated grader.

### Change
- New `structures.purpose_block()` — goal-framed text describing what SHELTER,
  DEFENSIVE WALL, STORAGE, and LIGHTING are FOR, in outcomes ("if a zombie walked up
  or it started raining, would someone inside be protected? if not it's not a
  shelter yet"), explicitly leaving the shape as the LLM's design decision. Asks the
  bot to state which goal a build serves and how its design achieves it, and to
  FINISH an unfinished structure (close the enclosure, add the roof) before starting
  something new.
- Injected into the propose prompt right after the village plan via a new
  `structure_purpose` param on `prompts.propose_prompt`, wired at both call sites in
  runner.py (main + no-reasoning retry).
- No critic change, no new geometry code, no blueprints. Smallest change that puts
  architectural INTENT in front of the LLM.

### Files
- `orchestrator/structures.py` (new `purpose_block`), `orchestrator/prompts.py`
  (new param + template slot), `orchestrator/runner.py` (wired both calls).

### Verified
- All three files parse. Smoke test confirms `purpose_block()` renders (~1.6k chars)
  and the SHELTER/mob-protection goals appear in the final assembled prompt.

### Still unverified / watch (this is an OBSERVATION run — watch, don't grade)
- The whole point: look at what bots build now. Do they enclose space? Add a roof?
  Leave a door? Do they FINISH a shelter before wandering off? Screenshot the
  results — your eyes are the judge this round.
- Watch reasoning/self-check lines for structure INTENT ("this wall serves mob
  protection because..."). If the LLM states a goal and its build matches, the
  goal-framing worked. If it states goals but builds pillars anyway, the gap is
  execution (the build skills can't realize the intent) — a DIFFERENT, later fix.
- Risk: goal text might push bots to over-invest in elaborate builds and neglect
  survival/gathering. If build tasks crowd out everything else, we dial back the
  emphasis. Not expected, but worth a glance.
- We did NOT define "how big" or enforce completion — a bot could still declare a
  1x1 box a shelter. That's fine for now; we're observing what it CHOOSES. Tighten
  later only if the emergent behavior needs it.

---

## 2026-07-08 (g) — Drowning-during-a-skill interrupt + no building while submerged

Screenshots showed Garrick standing IN a lake, swinging his axe, building a stone
wall OUT into the water — full health only because the server was on Easy. Root
cause: the (e) water gate only blocks a skill from STARTING while wet; it can't help
when a skill that started on land WALKS the bot into water. The watchdog stays
hands-off during a running skill (owner's rule), so the bot worked underwater the
whole task. Owner chose: (1) allow the watchdog to interrupt a skill for
life-threatening liquid ONLY, and (2) stop bots standing in water to build, while
still allowing docks/bridges built from dry footing.

### Fix 1 — drowning is the ONE exception to "watchdog never interrupts a skill"
- The tick guard no longer blanket-returns when `_skillRunning`. It computes a
  `drowning` signal — in liquid AND (in lava OR oxygenLevel <= 14 OR health <= 15) —
  i.e. genuine DANGER, not mere water contact. A bot building a dock in shallow
  water with full air is left alone; a bot actually losing breath is rescued.
- On a drowning interrupt: cancel the skill's pathfinder goal (so watchdog and skill
  don't fight), set `_skillInterruptedByDrowning`, and run the normal water escape.
- `runSkill` checks the flag and returns `{ok:false, env_failure:true}` for an
  interrupted skill — the bot was in mortal danger, not running buggy code, so it
  doesn't count against the skill or trigger a revision.

### Fix 2 — no building while submerged (docks/bridges OK, from dry footing)
- `placeAt` now refuses to place while the bot itself is in water: it first tries
  `stepToOpenGround(4)` to get to dry footing, and if still submerged, returns false
  (the placement is skipped; the watchdog pulls the bot out). Building INTO water is
  still allowed — you just have to stand on land / on the last placed block to do it,
  the way a player builds a pier. This directly stops the "swing axe underwater"
  behaviour in the screenshots.

### Files
- `node_host/bot_host.js` — `_skillInterruptedByDrowning` flag; drowning-exception
  in the watchdog tick; interrupt handling in `runSkill`; submerged-build guard in
  `placeAt`.

### Verified
- `node --check bot_host.js` passes. `stepToOpenGround` confirmed present. Traced the
  interrupt race: skill goal is cleared before the reflex runs, and runSkill reports
  env_failure whether the derailed skill returns or throws — no double-driving.

### Still unverified / watch (next run)
- Confirm `[watchdog] EMERGENCY: drowning during a skill` appears if a bot enters
  deep water mid-task, and that the bot escapes instead of drowning (test on Normal,
  not Easy, so drowning is real).
- The oxygen threshold (14) and health threshold (15) are first guesses — if bots
  get yanked out of shallow harmless water too eagerly (interrupting valid dock
  building), raise the bar toward actual-danger (e.g. oxy <= 6).
- Confirm bots can STILL build out over water from the shore (Fix 2 shouldn't block
  legitimate dock/bridge building — only building while standing in the water). If
  docks become impossible, the stepToOpenGround fallback needs a "place from the
  last solid block" mode instead of refusing.
- Garrick's wall-into-the-lake may also be a STRATEGY issue (why build a wall across
  a lake at all?) — worth watching whether the planner keeps choosing waterlogged
  build sites; if so, the build-site chooser should prefer dry ground.

---

## 2026-07-08 (f) — Post-30%-run fixes: shoreline oscillation, craft item-names, build-loop

First run on the full (a)–(e) stack. Big result: success rate 7.6% → 30.0% (140/466),
and the FIRST real structures — Mason built a stone storage wall + marked plan slot
'wall_segment_3' BUILT; Garrick placed 8 perimeter fences + 8 torches; bots
coordinated over a shared "village plan". The watchdog worked (214 water entries, 214
escapes, 0 deaths, 0 bound-hits). Three narrow bugs found and fixed.

### Bug 1 — shoreline oscillation (Rowan: 148 water entries, 9 ok / 109 fail)
- Root cause: `_lastDryPos` was being saved as ANY dry block the bot stood on —
  including one at the water's EDGE. The escape swam the bot to that edge block,
  "reached dry land", then the bot drifted one step back into water → repeat, ~every
  3s all run. The escape itself was fine (drift 0m, never hit bounds); the re-entry
  was the bug. Owner chose "re-plan on land, don't resume the old goal".
- Fix A: only record `_lastDryPos` when the cell has NO water/lava in its 8
  neighbours (or under them) — never target a shoreline block as "safe".
- Fix B: on exiting water, call new `stepInlandFromWater()` — finds the nearest
  water and walks ~4 blocks the OPPOSITE way onto solid ground before releasing
  control, so the bot re-plans inland instead of resuming a goal that points back
  across the water.

### Bug 2 — craft failures on guessed item names ("unknown item 'sticks'", 7x)
- The LLM guessed non-existent item names: "sticks" (real: "stick"), "plank"/
  "planks"/"wood" (need a species), "wood_pickaxe" (real: "wooden_pickaxe"). These
  were HARD craft failures blocking the wood→pickaxe path.
- Fix: `craftItem` now normalizes the name at entry — a FIX map for the common
  mistakes, `_plank`→`_planks`, and a final fallback that maps anything still
  containing "plank"/"stick" to oak_planks/stick. Cheap, unblocks crafting.

### Bug 3 — build-loop retrying finished/already-built wall slots (Mason: 9 stuck)
- `build_wall_segment` rebuilds from the bot's position each cycle; when it hit
  cells that already held the block, `buildLine` placed 0 NEW blocks, the critic
  (correctly) saw no world change → failure → the skill was retried endlessly
  ("stuck in a repetitive loop at coordinates that may already be complete").
- Fix: `buildLine` now SKIPS cells already holding the target block, counts
  `already` vs `placed`, and returns success with status `already_complete` when the
  whole segment already exists (a finished wall = done, not a failure). Only a run
  that placed nothing AND left the wall incomplete is an env_failure.

### Files
- `node_host/bot_host.js` — safe-ground `_lastDryPos` guard + `stepInlandFromWater`
  in the watchdog; `craftItem` name normalization; `buildLine` already-present skip.

### Verified
- `node --check bot_host.js` + `ast.parse` runner.py pass. All three fixes
  grep-confirmed.

### Still unverified / watch (next run)
- Rowan should now escape the shoreline and actually work (was 9/109). Watch its
  water-entry count — should drop from 148 to near-0. If it still oscillates, the
  inland step distance (4) or the neighbour-check radius needs widening.
- Confirm "unknown item" craft errors are gone.
- Confirm `build_wall_segment` stops looping — look for `already_complete` status
  and Mason moving on to the next plan slot instead of re-attempting the same one.
- Bots kept choosing "catch fish"/"scavenge food" with empty inventories and failing
  (no fishing rod, no fish nearby) — a STRATEGY issue, not mechanical: the proposer
  picks food tasks it can't execute. Likely next-tier: teach food priority to prefer
  achievable sources (animals/crops) or craft a rod first. Not fixed this round.
- 33 timeouts remain — worth a histogram next run to see which skills eat the 90s.

---

## 2026-07-08 (e) — Harden the survival watchdog: persistent water escape + cycle gating

The (d) watchdog kept bots ALIVE in water (good — no more drowning) but they just
bobbed: a run showed Garrick and Rowan stuck treading water for ~6 minutes straight,
never reaching land, `[watchdog] in water` printing every 0.5s. Three root causes,
all fixed. Owner-chosen behaviours: swim toward where the bot CAME FROM (not a
scanned heading that could point into open ocean), BLOCK cycles until on land, log
every 10s.

### Bug 1 — reflex swam 600ms then let go → perpetual bobbing
- The old reflex did one short burst and cleared controls, so the bot rose a little,
  sank, and repeated forever. Rewritten to be PERSISTENT: it holds jump + movement
  and does NOT clear controls between ticks, so swimming is continuous until the bot
  is genuinely on dry land. Controls clear only on reaching land or on bounded
  give-up.

### Bug 2 — no direction in open water; risk of swimming off forever (owner's concern)
- The old scan picked "nearest dry block", which in open water is null → bot only
  jumped in place. Worse, a scanned heading could point DEEPER into an ocean and,
  once a cycle ended, march the bot thousands of blocks away.
- Fix: the escape target is now the LAST DRY GROUND the bot stood on (tracked each
  tick when onGround + not in liquid) — i.e. the way it came in, which provably had
  land. Falls back to a short local land-scan, then to "swim back toward the entry
  point" if there's no memory. Because liquidCost=60 makes deep-water entry rare
  now, this is an edge case, so it's kept simple rather than over-built.
- BOUNDED so a bot can NEVER drift away: if it can't reach land within ~45s or ~150
  blocks of the entry point, it stops and holds position (still alive — treading
  beats drowning), logging once. No platform-building / no /tp (would need op and is
  an unsafe assumption).

### Bug 3 — in-water bots wasted every cycle failing
- A bot treading water ran skills that all failed "could not reach a block". Added a
  WATER GATE in the host `run_skill` handler: if `_inWaterNow`, the skill is skipped
  and a benign `blocked_in_water` result is returned with `env_failure:true`, so the
  orchestrator doesn't count it as a code failure or revise the skill. The bot does
  exactly one thing while wet: get to shore (the watchdog handles it).
- `runner.py` `is_environmental_failure` now also honors a TOP-LEVEL `env_failure`
  flag (the water gate sets `data.env_failure` with `result=null`), not only the one
  nested in `result`.

### Logging — every 10s, not every tick
- The `[watchdog] in water` flood (2/sec) is gone. Now: one line on entering water,
  a progress line at most every 10s, one line on reaching land ("cycles unblocked").

### Files
- `node_host/bot_host.js` — `_lastDryPos`/`_waterEpisode`/`_inWaterNow` state;
  persistent+bounded+backtracking `reflexWater`; last-dry tracking + land-exit clear
  in the tick; water gate in `handle()`'s run_skill.
- `orchestrator/runner.py` — top-level `env_failure` honored.

### Verified
- `node --check bot_host.js` + `ast.parse` runner.py both pass. Traced control-clear
  points: continuous-swim path never clears (the fix); clears only on land / bounded
  give-up. Water is checked before other reflexes so they don't interrupt a swim.

### Still unverified / watch (check in the next run)
- Confirm a bot that enters water now REACHES land within a few seconds and logs
  "reached dry land — cycles unblocked", instead of bobbing. Garrick/Rowan spawned
  IN water this run — watch spawn positions; if bots keep spawning wet, the spawn
  point itself is near water (a world/config issue, not the watchdog).
- Confirm the 10s throttle holds (no more per-tick flood).
- If a bot ever hits the 45s/150m bound repeatedly, it's genuinely in open ocean —
  revisit whether a "place blocks to make a platform" fallback is worth adding then,
  but only if it actually happens.
- `_lastDryPos` is per-process memory; a freshly-spawned bot standing in water has
  none yet, so it uses the entry-point backtrack. Fine, but means the very first
  seconds of a wet spawn rely on the local scan.

---

## 2026-07-08 (d) — Survival watchdog + stronger water avoidance (fix idle-time deaths)

Trigger: Flint walked toward food, pathed into water, and DROWNED in the gap between
one mineflayer path and the next — passive the whole time. Owner correctly noted this
is really a "delay between cycles" problem, not just water: a mob could kill an idle
bot the same way. A cycle spends 60–160s in the propose (reasoning) call plus
between-skill gaps, during which no skill code runs and the bot is a ragdoll.

### Layer 1 — pathing (avoid getting INTO trouble)
- `moves.liquidCost` 24 → 60. It was ALREADY avoiding liquid at 24, but a loose
  explore-hop GoalNear accepted a target across water and the partial path still put
  Flint in. Higher cost makes the planner route well around liquid unless there is
  genuinely no land path. Note: pathing alone can't fix the DELAY — hence Layer 2.

### Layer 2 — survival watchdog (survive trouble that happens anyway)
- New always-on `installSurvivalWatchdog()` in bot_host.js, registered on spawn.
  A ~4Hz timer runs reflexive survival actions during the DEAD TIME between/around
  cycles. Owner chose the safest gating: it acts ONLY when `_skillRunning` is false,
  so it is completely hands-off while a skill drives the bot and never fights the
  skill's pathfinder for movement controls.
- `_skillRunning` is set true/false around the skill body in `runSkill`. `runSkill`
  also now clears control states at skill START, so a watchdog burst still finishing
  (its 600-700ms window) can't bleed into the skill.
- Four reflexes (all owner-selected), one per tick, priority-ordered:
  1. WATER/LAVA: if in liquid, hold jump to swim up + walk toward the nearest dry
     standing spot (scans out to 12 blocks). Drowning is the fastest death so it's
     first. Also covers "sinking in deep water".
  2. SUFFOCATE: head block solid → jump+forward to hop out.
  3. FLEE: a hostile (zombie/skeleton/creeper/drowned/... ) within 8m → face it and
     walk backward away, sprinting.
  4. EAT: health ≤12 or food ≤16 and food in inventory → equip + consume.
- Safety: non-reentrant (`_watchdogBusy`), every reflex clears its own control
  states so it never leaves the bot walking, and reflex errors are caught so they
  can never kill the host. Most ticks bail instantly on the guard (cheap).

### Files
- `node_host/bot_host.js` — liquidCost 60; `_skillRunning`/`_watchdogBusy` state;
  `installSurvivalWatchdog()` + call on spawn; control-clear at skill start.

### Verified
- `node --check bot_host.js` passes after every edit. Vec3 confirmed module-scope;
  installSurvivalWatchdog is a hoisted declaration so the spawn handler can call it.

### Still unverified / watch (check in the next run)
- Confirm `[watchdog]` log lines appear during propose gaps (e.g. "in water —
  swimming up/out") and that a bot that enters water now recovers instead of dying.
- Watch that the watchdog does NOT act mid-skill — there should be no `[watchdog]`
  line interleaved between a skill's own `[bot]` lines. If one appears, the
  `_skillRunning` gate needs tightening.
- The flee reflex walks straight back — it could back a bot off a cliff or into
  water. Acceptable first cut; if it causes new deaths, add a "don't retreat into
  liquid/void" check to the heading.
- Swim-to-land scans a fixed 12-block ring; in a large open ocean it may find no dry
  spot and just tread water (still better than drowning). If bots spawn near big
  water, consider a longer scan or a "place a block to stand on" fallback.
- lava reflex swims "up/out" like water, but lava kills faster than the 600ms burst
  may allow; if a bot dies in lava anyway, lava needs its own faster/again-loop.

---

## 2026-07-08 (c) — Second-tier fixes: exploration, placement bug, escape infinite-loop

Follow-up to (b), driven by a fresh 4-bot / ~2h36m run (Mason, Garrick, Flint,
Rowan). That run was a breakthrough vs the pre-(b) baseline — ALL FOUR bots reached
stone tools, and the tech tree ran to stone swords, fences, chests, deposits, and
tree-planting. So (b) worked. This entry fixes the NEW, later problems that surfaced
once the bots were no longer stuck at the wooden-pickaxe wall. Three fixes, in the
priority order the owner chose.

### Fix 1 — Exploration when local resources deplete (top priority)
- Symptom (dominant late-game failure): bots chopped spawn (~-108,68) bare, then
  spammed `collect_and_handle_stuck_logs` → "no logs of any species nearby" forever.
  They REASONED correctly ("I must navigate to a forest biome") but the gather
  helper only searched a fixed radius and quit — no way to relocate. `gather_wood`
  got BLOCKED on every bot in the back half.
- Fix: new primitive **`exploreFor(nameSubstr, opts)`** in bot_host.js — walks the
  bot outward in hops (default 6 hops × 40 blocks) on a RANDOM heading (so the four
  bots spread out instead of stripping one corridor), re-scanning after each hop
  until the target block type is within scanRange. Pure surface travel, never digs.
- `collectAnyLog` now calls `exploreFor('_log')` automatically when no wood is
  local, then re-checks. The frozen wood-collection skills benefit with NO rewrite.
- Uses the proven `goals.GoalNear(tx, curY, tz, 8)` (NOT an unverified GoalNearXZ)
  so it can't crash on a missing goal type; range 8 avoids exact-block "no path"
  stalls.

### Fix 2 — Placement bug: `build_temporary_shelter` never once succeeded
- Root cause (found in the skill code, not guessed): the skill computed every
  target from `bot.entity.position` — so the bot was trying to place blocks INTO
  the cell it was standing in. You can't. All 8 placements failed every cycle →
  "Failed to place at ..." ×9 → `build_structure` permanently BLOCKED.
- Fix A (primitive, `placeAt`): now STEPS ASIDE (`stepToOpenGround`) if the bot
  occupies (or stands just below) the target cell before placing; and tries ALL
  solid neighbour faces, not just the single block below (which was often
  unreachable). This makes any skill calling placeAt robust, per the given/developed
  split — the primitive owns "how to place a block."
- Fix B (skill): rewrote `build_temporary_shelter.js` to build a 2×2 floor + corner
  walls ADJACENT to the bot (base corner +2x/+2z), never underfoot, and to count
  NEW blocks placed (returns `shelter_progress` / `placed`) instead of all-or-
  nothing. Backed up old version to /tmp before overwrite.

### Fix 3 — Escape infinite-loop + wire up the new verbs
- Symptom: `escapeToSurface` printed "mining up through ceiling" 60+ times in a row
  then hit the 90s skill timeout — Garrick/Rowan lost whole cycles. The loop ran to
  maxRise=80 even when the bot gained ZERO height (bedrock/unbreakable ceiling); the
  `stalls>=4 → getUnstuck` handoff reset the counter but never broke the loop.
- Fix: added a `noProgressStreak` counter; after 8 iterations with no net Y gain it
  RETURNS `{ok:false, method:'gave-up-no-rise'}` cleanly so the proposer picks a
  different action next cycle instead of grinding to the timeout.
- Contract now advertises `exploreFor`; added rules banning invented helper names
  (`collectFromDistance`, `collect` — both caused crash-failures in the run) and
  banning in-place retry of a gather that just reported "none nearby".

### Critic: stop false-failing INCREMENTAL builds
- The build path was still all-or-nothing graded: "placed 7 of 9 planks" = fail,
  "chest one block off target" = fail, "plank already present" = no-op fail. This
  wrongly flagged the (correct) build code and kept re-blocking build_structure.
- `critic_prompt` now says building is incremental: ONE new block placed = SUCCESS;
  a block one coordinate off = SUCCESS; only fail a build when ZERO new blocks land.
- Added the partial-build / coordinate-mismatch phrases to runner.py's
  `is_environmental_failure` list so a partial build never triggers a skill rewrite.

### State reset (one-time, ran during this session)
- Cleared `state/capabilities.json` (it carried last run's BLOCKED capabilities
  forward — those blocks were caused by the now-fixed bugs, so they'd wrongly
  suppress the fixed capabilities). Reset build-skill counters. Script was one-shot
  and deleted after running.

### Files
- `node_host/bot_host.js` — new `exploreFor`; `collectAnyLog` auto-travels;
  `placeAt` steps aside + tries all faces; `escapeToSurface` no-progress bailout.
- `skills/working/build_temporary_shelter.js` — build adjacent, count progress.
- `orchestrator/prompts.py` — advertise exploreFor; ban invented methods + in-place
  gather retry; critic grants partial-build success.
- `orchestrator/runner.py` — partial-build/coordinate-mismatch added to env-failure.
- `state/capabilities.json` — reset (transient state, not normally tracked here).

### Verified
- `node --check bot_host.js` passes; all Python files `ast.parse` clean; the
  rewritten shelter skill parses inside the runtime's async wrapper (top-level await
  is valid there, so a standalone `node --check` warning is expected/benign).
- All six fixes grep-confirmed present in the shipped files.

### Still unverified / watch (check these first in the next run)
- Fix 1: confirm bots actually TRAVEL on "none nearby" (look for movement + a later
  successful gather) rather than a treeless-biome dead end. exploreFor's random
  heading is a heuristic — if all four still clump, bias headings by bot id.
- Fix 2: confirm `build_temporary_shelter` logs `shelter_progress` with `placed>0`.
  If placeAt still fails, the next suspect is reach distance to the neighbour face
  (the goto range) or the ground-check refusing a valid grass cell.
- Fix 3: confirm the 60-line "mining up through ceiling" wall is gone (should bail
  within ~8 iterations). Watch that the bailout doesn't strand a bot that COULD have
  escaped with a few more tries — 8 was chosen conservatively.
- The new farming/combat verbs (till/plant/harvest/attack/eat) are advertised but
  were barely exercised in the last run; next run should show whether the proposer
  reaches for them now that food/defence matter.
- Likely THIRD-tier issues next: multi-bot coordination on who builds what, food
  actually sustaining bots, and the still-unbuilt social/proposal layer.

---

## 2026-07-08 (b) — Break the 4-day stall: fix the critic + stop skill-destruction; add primitive verb core

Context: owner reported ~4 days / 30+ hrs stuck on BASICS (movement, gather, craft)
with nothing built. Diagnosis in (a) below. This entry is the fix. Two parts, both
chosen with the owner after showing the failure histogram; deliberately conservative
(added a clean layer, did NOT rip out the ~40 existing helpers) to avoid regressions.

### Part 1 — Fix the too-strict critic + stop the self-destruction loop
- Root cause: `success_looks_like` was generated with EXACT quantities (the prompt's
  own example was "cobblestone increased by 5"), and the critic enforced them
  literally — so "mined 7 when 5 asked", "acacia log when oak asked", "placed a
  block so cobble went 10→9" all scored FAILURE despite real progress. Those false
  fails then tripped the auto-revision system, which rewrote WORKING skills into
  worse ones — the source of the 11 duplicate wood-collection skills and ~15 craft
  variants on disk. Measured: 48 successes / 583 failures = 7.6% over 631 attempts,
  of which only ~17 were actual LLM code errors (<3%).
- `prompts.py` — `success_looks_like` spec now demands QUALITATIVE gains ("more
  cobblestone than before"), never exact numbers; overshoot is explicitly success.
- `prompts.py` — `critic_prompt` rewritten: judge by DIRECTION not exact quantity;
  overshoot / undershoot-with-progress / valid variants all = success; kept the
  genuinely useful no-op detection (item already present + no change = fail). Owner
  chose to KEEP the LLM critic (not hardcode a Python checker) after we discussed
  that hardcoding a judge is a new regression surface ("didn't code for that") and
  fights the whole point of using an LLM. Fix the RULE, not the judge.
- `skills.py` — `needs_revision` threshold raised: was revise at fails≥uses (min 2),
  destroying skills on 2 (often false) fails. Now requires ≥5 real fails AND
  fails>uses+1, and NEVER revises a frozen/canonical skill.
- `runner.py` — quantity-mismatch verdicts ("instead of the required", "only
  collected", "instead of oak", etc.) added to `is_environmental_failure` so they
  never trigger a rewrite.
- One-time library cleanup (ran + deleted): reset the POISONED fail-counts on the 8
  proven canonical skills (their code was fine; the counts were critic lies),
  un-retired 3 wrongly-retired canonicals, archived 4 timestamped duplicate skill
  files to skills/archive/. Nothing deleted.

### Part 2 — Primitive "verb" core (given/developed split)
- Principle agreed with owner via his own analogy: the bot shouldn't have to be
  taught to WALK (mechanics = given), but should develop SKILLS like what/whether/
  where to craft/build/farm (decisions = LLM). Verbs are given; every noun and
  decision stays with the LLM.
- Most primitives already existed as helpers; the gaps the logs proved were combat,
  farming, survival, and tooling. Added to bot_host.js: `equipBestToolFor` (stop
  mining stone with a wooden pickaxe), `attack` (LLM picks the target), `eat`
  (survival reflex), `till` / `plant` / `harvest` (LLM picks crop/where/when).
- `prompts.py` — advertised the new verbs; added the framing rule "YOUR JOB IS TO
  CHOOSE AND SEQUENCE, NOT RE-IMPLEMENT MECHANICS" so the LLM composes primitives
  instead of hand-writing the fragile find/path/dig loops that were dying.
- Reference — the ~12–15 verb GIVEN core: gotoXYZ, collectBlock/collectAnyLog/
  acquireStone, craftItem, depositToChest/withdrawFromChest, getUnstuck/
  escapeToSurface, placeAt/placeNearby/buildLine, equipBestToolFor, attack, eat,
  till, plant, harvest. DEVELOPED (LLM): what/how-much/where/whether/layout/strategy.
- `runner.py` — LLM-endpoint-down errors (broken pipe / connection refused / bad
  request) now back off 30s instead of hammering a dead box every 3s (the log
  storms). No server/model changes — the slow V100 + 24GB-Mac critic are fixed
  constraints we design AROUND (call the LLM less, waste fewer calls), not bugs.

### Files
- `orchestrator/prompts.py`, `orchestrator/skills.py`, `orchestrator/runner.py`,
  `node_host/bot_host.js`. One-time `cleanup_skills_once.py` (ran, then deleted).

### Verified
- All Python `ast.parse` clean; `node --check bot_host.js` passes; 6 new verbs
  grep-confirmed; cleanup ran (8 reset, 3 un-retired, 4 duplicates archived).

### Still unverified / watch → superseded by the (c) run above, which confirmed this
    worked (all 4 bots reached stone tools). Remaining issues became the (c) fixes.

---

## 2026-07-08 (a) — Diagnostic baseline (no code change): why the 4-day stall happened

Pure analysis session that produced the (b) fix. Recorded here so the reasoning is
tracked, not just the edits.

### What the data showed (from state/*.json + 4 bot logs, not impressions)
- Canonical "frozen" skills failing 75–90%: `craft_wooden_pickaxe` 3 ok/26 fail,
  `collect_and_handle_stuck_logs` 6/18 — yet their CODE is clean (straight helper
  calls). Failures were inside helpers or the critic, not the LLM's decisions.
- `lessons.json`: 20 lessons over two days, almost all re-phrasings of the SAME
  three plumbing bugs ("verify inventory/item/tool before crafting") — the learning
  system was re-discovering the same failures, not compounding knowledge.
- Skill library thrash: 11 wood-collection variants, ~15 craft variants on disk =
  the auto-revision loop writing its own churn to disk.
- The model is NOT the bottleneck: actor = Qwen (V100, ~60–160s reasoning calls);
  <3% of failures were LLM code errors. A smarter model changes almost nothing.
- Gap vs intent: GOVERNANCE_PLAN.md (07-06) said bypass the mechanical layer and
  build the social layer; instead README v7–v13 kept perfecting mechanics, and the
  social/proposal layer has zero lines of code. Owner corrected course: he does NOT
  want permanent handouts — the bots must genuinely get/craft/move/build on their
  own, so the mechanical layer is load-bearing and must actually work (→ the (b)
  fix targets making it work, not skipping it).

### Files
- None (analysis only).

---

## 2026-07-06 (p) — vLLM switch + reasoning tuning + call-type-aware LLM observability

Owner moved the actor endpoint from Unsloth Studio to vLLM (Unsloth's llama-server
defaulted to `--parallel 1` = serialized, which capped throughput; confirmed via the
`unsloth studio -h` help showing parallel-slot default 1). vLLM does real continuous
batching. This entry covers the vLLM cutover and the reasoning-model tuning that
followed.

### vLLM endpoint (llm.py)
- Actor model name → `qwen3.6-35b` (vLLM `--served-model-name`; old unsloth mtp name
  would 404). URL/key unchanged.
- `MAX_CONCURRENCY` 6 → 12 (vLLM `--max-num-seqs 32` batches far more than the old
  single llama.cpp slot).

### Reasoning model handling (Qwen3.6 is a REASONING model)
- Symptom: with reasoning left ON globally + `max_tokens=2048`, every call generated
  a long `<think>` trace that ate the budget → truncated JSON, 300s timeouts, then
  (when budget raised) 100-168s calls as 4 bots piled into overlapping long
  generations.
- Fix: reasoning is now PER-CALL, not global. `think=True` only on the PROPOSE call
  (strategy/self-check — where reasoning helps civilization goals); code-gen,
  revise, naming, lessons run FAST with reasoning off. ~4× fewer expensive calls per
  cycle. Reasoning calls get max_tokens=6000; mechanical calls 2048.
- `_strip_think()` removes the `<think>` block from responses before JSON parsing
  (incl. truncated traces) so reasoning can't corrupt the parsed task/code.
- Crash fix: a propose reply missing `task` (truncated reasoning) now logs +
  returns `propose_no_task` instead of raising `KeyError: 'task'` (was seen as
  `Mason cycle error: 'task'`).

### Call-type-aware slow detection (owner request)
- The old `SLOW call took Ns` fired on ANY call >30s — couldn't tell a legitimately-
  slow reasoning call from a genuinely-problematic slow code-gen call, so it cried
  wolf on reasoning.
- Now: reasoning calls slow only past SLOW_REASON_S=120s; mechanical calls past
  SLOW_MECH_S=35s. Every call carries a `label` (strategy/code-gen/naming/
  revise-code/lesson) shown in the warning. New per-type breakdown logged each cycle:
  `by-type — code-gen: 12x 14s avg | strategy: 4x 78s avg (1 slow)`. Now you can SEE
  which call type is slow, and only the ones that MATTER (fast calls going slow)
  alert.

### GPU / vLLM startup notes (for future scaling)
- `--gpu-memory-utilization 0.95` on the dedicated .128 card is FINE (nothing else
  on the GPU). The ~99% nvtop reading is vLLM pre-allocating its KV-cache pool by
  design, not a leak. Would only be risky if another process shared the GPU.
- **PENDING (owner will apply on next vLLM restart):** `--max-model-len 32768 →
  16384`. KV-cache per sequence is sized by max-model-len; real need is ~10k
  (4k input + up to 6k reasoning output), so 32768 reserves ~3× unused context.
  Dropping to 16384 ~doubles concurrent-sequence capacity in the same VRAM — the
  cheapest bot-scaling win available. Verify via vLLM boot log "Maximum concurrency
  for N tokens" line before/after. Keep max-model-len > input+output or requests
  error.

### Files
- `orchestrator/llm.py` — vLLM config, per-call reasoning + labels, type-aware slow
  thresholds, per-label stats.
- `orchestrator/runner.py` — propose call `think=True, label="strategy"`; mechanical
  calls labeled; no-task crash guard; per-type health line.

### Still unverified / watch
- Confirm which no-think method the vLLM build honors if reasoning is ever disabled
  (chat_template_kwargs vs /no_think token) — _strip_think is the safety net either
  way.
- If a single reasoning propose call is still too slow at 4 bots, next lever is
  capping reasoning length (reasoning_max_tokens) rather than disabling it.

---

## 2026-07-06 (o) — SQLite migration (live) + two new bots (Flint gatherer, Rowan farmer)

Two changes together (owner OK'd, backable). (1) Wired the entry-(m) SQLite store
into the actual blackboard + structures, so shared state is now concurrent-safe for
scaling. (2) Added bots 3 and 4.

### SQLite migration (blackboard + structures now on the store)
- `runner.py` blackboard functions (`post_note`/`read_blackboard`/`write_blackboard`)
  now back onto `store.py` (WAL SQLite) instead of blackboard.json. Interface
  UNCHANGED — every caller works as-is. One-time auto-import of existing JSON notes
  so an in-progress world keeps its memory.
- `structures.py` `_load`/`_save` now back onto the store under a kv key. All 15+
  public functions (workshop, plan, registry) migrate via this single swap, no
  signature changes. Auto-imports legacy structures.json once.
- `reset_run.py` now also clears the store (notes always; kv/plan on --hard or
  fresh, kept on --keep-world).
- Verified end-to-end: legacy JSON auto-migrated, concurrent read/write works,
  interfaces identical. Stress test from entry (m): 8 threads, 160 atomic updates,
  0 lost.

### New bots
- **Flint (resource gatherer/supplier):** purpose is to keep builders stocked —
  mine/chop/gather and DELIVER surplus to shared chests so Mason can focus on
  building instead of gathering. This is the "move Mason toward building" goal:
  offload the gathering to a dedicated supply line.
- **Rowan (farmer/food):** keep the community fed; establish crop farming if
  feasible, else fall back to food collection. Goal is deliberately written to
  DEGRADE GRACEFULLY — "a fed community, however achieved" — so it's useful even if
  farming mechanics prove too hard.

### New primitive unlocking the supply line: chest storage
- Both new bots' core loop needs to put items in shared chests — but NO chest
  helper existed (same missing-primitive pattern as smelt). Added
  `depositToChest(items)` and `withdrawFromChest(items)` using the verified
  mineflayer 4.37.1 container API (openContainer -> window.deposit/withdraw),
  null-guarded so a missing chest can't crash the runner. Documented in the
  contract. Without this, Flint would just hoard like the old behavior.

### Files
- `orchestrator/runner.py` — blackboard on store; store import.
- `orchestrator/structures.py` — load/save on store.
- `orchestrator/config.py` — Flint + Rowan bot configs.
- `node_host/bot_host.js` — depositToChest/withdrawFromChest.
- `orchestrator/prompts.py` — chest helpers documented.
- `reset_run.py` — clears store.

### Verified
- All compile/parse; 4 bots configured (1 decider: Mason); chest API matches
  installed mineflayer 4.37.1.

### Still unverified / honest caveats
- **Rowan farming will likely struggle at first** — there are NO till/plant/harvest
  primitives, so the "farm" half means the LLM hand-writes raw farming code (the
  pattern that failed for smelting until a primitive existed). Its goal degrades to
  food-collection, so it won't be useless, but expect the farming to be rough until
  a farming primitive is added. Food COLLECTION (hunting) also has no dedicated
  helper — leans on generic movement/attack. If Rowan thrashes, pull it and keep
  Flint (owner already flagged this fallback).
- 4 bots × ~2.8 actor calls/cycle now share one Qwen box. With batching this should
  hold (~7-10 bot ceiling estimated), but WATCH the entry-(n) llm-health line —
  rising latency/retries means you've hit the box's real limit.
- Flint/Rowan depositing depends on a chest existing at the workshop; if none is
  placed yet, depositToChest will place one (if held) or report needChest.

---

## 2026-07-06 (n) — LLM observability: surface retries/timeouts/slow calls

First live run of the scaling changes (entry m) confirmed the win: Mason & Garrick
now OVERLAP their cycles (both mid-LLM-call at the same timestamps, vs taking turns
before) — the semaphore lets Unsloth batch them. Retry cut also visible ("gave up
after 2 attempts"). But the run exposed a blind spot the owner flagged: LLM failures
were retried and swallowed SILENTLY — no way to see box overload coming.

### What changed (llm.py + runner.py)
- **Per-endpoint stats**: calls, avg latency, retries, timeouts, failures, slow
  calls. `stats_line()` prints a health summary each cycle:
  `llm health — ACTOR_HOST: N calls, Xs avg, R retries, T timeouts, F failed`.
- **Live warnings** via a log hook: SLOW calls (>30s), TIMEOUTs, per-attempt
  errors, and final GAVE-UP now print immediately instead of vanishing.
- **Why it matters for scaling**: as concurrency rises, the FIRST symptom of an
  overloaded box is rising latency + retries, NOT hard failure. This makes that
  visible so you can tune MAX_CONCURRENCY (or add a box) before things break.

### Confirmed from the live run
- Concurrency working: bots' LLM calls overlap in the timestamps (were serialized).
- Speedup came from BOTH levers — batching (overlap) + retry cut (failures cost 2
  attempts not 4). Owner's read was correct on both.

### Files
- `orchestrator/llm.py` — stats tracking, log hook, richer error paths.
- `orchestrator/runner.py` — set log hook; print health line each cycle.

### Watch as you scale
- If `avg` climbs steeply or `retries`/`timeouts` appear, the box is under
  concurrency pressure — lower MAX_CONCURRENCY or add an actor box.

---

## 2026-07-06 (m) — Scaling groundwork: batching, fewer retries, SQLite store

Planning for horizontal scale to 10-20 bots. Root finding: the ceiling was never
hardware — it was the `_chat` LOCK serializing all LLM calls to one-at-a-time,
which defeated Unsloth Studio's continuous batching (confirmed: Unsloth via
vLLM/HF batches concurrent requests token-by-token). Measured from real logs: one
Qwen box saturated at ~2 bots.

### What changed
1. **Semaphore instead of exclusive lock (`llm.py`).** Replaced the one-request-
   at-a-time gate with a bounded `MAX_CONCURRENCY=6` semaphore per endpoint, so
   Unsloth can actually batch concurrent requests. Removed the MIN_GAP spacing
   (batching makes it counterproductive). Still bounded so a runaway can't blow
   the KV cache.
2. **MAX_RETRIES 4 → 2 (`config.py`).** Log analysis: 78-92% of successes land by
   attempt 2; attempts 3-4 rescued only ~2 tasks across a full run while ~doubling
   actor calls. Big LLM-load saving at negligible capability cost.
3. **`store.py` — SQLite (WAL) shared-state layer (NEW).** kv + append-notes with
   atomic `kv_update` (BEGIN IMMEDIATE, no lost updates) and WAL (concurrent
   readers + writer). Stress-tested: 8 threads × 20 iters = 160 atomic updates,
   0 lost, 0.08s. Ready to back the blackboard/plan as bot count grows.

### Combined effect (measured/estimated)
- One Qwen box: ~2 bots  →  **~7-10 bots** (batching + fewer retries), NO new hardware.
- Beyond ~10: add actor boxes (linear). ~20 bots ≈ 3-4 actor + 2 critic boxes.

### Files
- `orchestrator/llm.py` — semaphore gate.
- `orchestrator/config.py` — MAX_RETRIES=2.
- `orchestrator/store.py` — new SQLite store (built + tested, NOT yet wired in).

### Still unverified / deliberately deferred
- **`store.py` is NOT yet wired into blackboard.py/structures.py.** That's 47
  read/write sites across 5 modules — a careful mechanical migration that deserves
  its own focused pass + live verification, not a rushed half-migration where file
  and DB disagree. The layer is proven; the swap is next.
- `MAX_CONCURRENCY=6` is a starting guess — tune to what the GPU holds without
  latency collapse. Watch actor latency as you add bots; if it climbs steeply,
  lower it or add a box.
- Batching multiplier (2.5-3.5x) is estimated; real number depends on your GPU's
  KV-cache headroom for a 35B-a3b MoE. Measure once running >2 bots.
- reset_run.py should also call store.reset() once the store is wired in.

---

## 2026-07-06 (l) — Shared village plan: coordinate building against a common layout

The self-check (entry k) worked — agents stayed on the surface and Mason caught
himself ("I have drifted into pure resource accumulation without constructing any
infrastructure") and built a shelter + wall. But building was still uncoordinated:
two agents improvising separate structures = chaotic, not organized. Per Project
Sid, the coherence that makes a settlement look planned comes from a SHARED ARTIFACT
all agents build against (Sid used a shared doc / constitution), not from smarter
individual reasoning. This adds that artifact.

### What changed
1. **Village-plan API in `structures.py`** (`get_plan`/`set_plan`/`claim_slot`/
   `complete_slot`/`plan_block`). The plan is a list of named build slots (shelter,
   wall, gate, path...) each with a position and status (planned→claimed→built),
   anchored at the workshop. Concurrency-safe via the existing lock. Re-planning
   preserves already-claimed/built slots.
2. **Decider designs it, system only stores it** (fidelity principle): the LLM
   (Mason, city builder) proposes the actual layout; the system coordinates
   who-builds-what. The plan CONTENT is a strategic choice, left to the agent.
3. **Proposer prompt** now injects the plan and tells agents: if decider & no plan,
   propose one; if a plan exists, claim an OPEN slot and build THAT — "build where
   the plan says, not wherever you happen to stand."
4. **New `plan_action` JSON field**: `{propose:[slots]}` (decider only),
   `{claim:id}`, `{complete:id}`. Runner applies these, logs 🏛/📌/✅, and posts
   `[plan]` notes to the blackboard so both agents see progress.

### Files
- `orchestrator/structures.py` — village-plan API.
- `orchestrator/prompts.py` — plan injection + `plan_action` reply field.
- `orchestrator/runner.py` — pass plan block; handle propose/claim/complete.

### Verified
- All compile; end-to-end smoke test passed (Mason proposes 2 slots → Garrick
  claims the wall → plan shows CLAIMED [Garrick]). Test artifact cleared from state.

### Still unverified / watch for
- Behavioral — needs a live run. Watch for: `🏛 Mason proposed a village plan`,
  `📌 ... claimed slot`, `✅ ... marked BUILT`, and `[plan]` blackboard notes.
- Whether Mason proposes a SENSIBLE layout and whether Garrick actually builds his
  claimed slots at the planned positions (spatial reasoning is the known Sid
  weakness — positions may be rough).
- Two agents can COORDINATE via a plan but won't SPECIALIZE emergently — that needs
  more agents (owner deferring until basics are solid).

---

## 2026-07-06 (k) — Situational self-check: nudge agents from collectors toward purpose

Observation from a long run (both bots reached iron/torches — tech tree works)
but they behaved as pure resource-collectors: followed acquisition sub-goals blindly
DOWN into a cavern (Garrick to Y=30, Mason stuck 15 cycles in a hole) with no regard
for their actual identities (Mason=city builder, Garrick=protector). Root cause was
in the proposer PROMPT, not the code: one line of "purpose" sat atop ~20 lines of
relentless "PREREQUISITES FIRST / get the missing input / next small step" laddering.
The prompt optimized for acquisition; identity had no mechanical weight, and nothing
ever asked "does my current situation serve my purpose?"

### What changed (prompt-level only — no helper/mechanic changes)
1. **STEP 0 situational self-check** added to `propose_prompt`, BEFORE prerequisite
   laddering: the agent must assess whether its location (Y-level, underground vs
   surface), inventory (already have plenty?), and trajectory actually serve its
   purpose — and if not, propose a corrective task (surface, go to community area,
   actually build/defend) rather than gathering more.
2. **Agency preserved (owner decision):** the agent MAY choose an odd situation
   (e.g. settling in a cavern) IF it justifies how that serves its purpose. That
   justification is REQUIRED in a new `situation_note` field and gets posted to the
   shared blackboard, so a cave-city is a defensible choice, not a blind drift.
3. **New JSON fields:** `situation_assessment` (logged each cycle as `self-check:`)
   and `situation_note` (posted to blackboard as `[purpose] ...` when non-null).

### Files
- `orchestrator/prompts.py` — STEP 0 self-check; `purpose_short`; two JSON fields.
- `orchestrator/runner.py` — log the assessment; post justification via post_note.

### Verified
- Both files compile; `purpose_short` renders the identity clause correctly.

### Still unverified / intent
- Effect is behavioral and can only be seen live. Watch the log for `self-check:`
  lines and whether tasks start correcting off-purpose situations (e.g. Garrick
  proposing to surface/patrol instead of mining deeper). Owner will restart the
  world and run several hours.
- This is the FIRST social-layer change (per PROJECT DIRECTION). Deliberately
  minimal — one reflective step — to see if subtle "am I doing my purpose?"
  prompting yields more concrete strategizing before adding heavier mechanisms
  (purpose overriding tasks, act-vs-collect rebalance) considered but NOT done yet.

---

## 2026-07-06 (j) — "Knowledge, not goods": persist skills across runs; reset/curate tools

Owner direction (see PROJECT DIRECTION in GOVERNANCE_PLAN.md): skip the caveman
prologue WITHOUT going creative-mode. The resolution — give agents the KNOWLEDGE
(the learned skill library) so they don't re-derive how to make a pickaxe every
run, but NOT the goods (no inventory injection — they still gather and craft).
The library was being wiped between runs "to clear the crap," causing amnesia:
every fresh start re-learned the same ~10 caveman skills from scratch.

### What changed
1. **`reset_run.py`** — start a fresh run without amnesia. Clears CLUTTER
   (blackboard, scattered structures, poison lessons, trailing capability-fail
   streaks so nothing starts BLOCKED) while KEEPING knowledge (skills) and
   standing goals. Flags: `--hard` (also wipe lessons/capabilities/progress, true
   baseline), `--keep-world` (resume a build), `--dry-run`. Backs up state first;
   never touches skills.
2. **`curate_skills.py`** — de-duplicate the library, keeping one version per
   concept by a transparent score (`uses - 2*fails - revisions`, tie → newest),
   archiving the rest (recoverable, not deleted). Dry-run shows the plan.
3. **`config.py` header** — documents the "knowledge, not goods" workflow so
   future sessions use `reset_run.py` instead of `rm -rf skills/`.

### Files
- `reset_run.py`, `curate_skills.py` (new, repo root).
- `orchestrator/config.py` — workflow note.
- `GOVERNANCE_PLAN.md`, `README.md` — PROJECT DIRECTION (owner priorities: the
  goal is emergent civilization; mechanical layer is plumbing; governance no
  longer gated behind a perfect survival loop).

### Verified
- Both tools compile and run in `--dry-run` cleanly against current state:
  curate would collapse 4 duplicates → clean concept set; reset would keep 23
  skills + prune 1 poison lesson + clear 4 stale capability-fail tails.

### Still unverified / notes
- Because the mining FIX lives in the helpers (`acquireStone`/`digStaircaseDown`),
  it doesn't matter much which duplicate `mine_cobblestone` skill curate keeps —
  both call the now-fixed helper. Curation is cosmetic, not correctness.
- Not yet run for real (dry-run only) — the owner runs these when starting the
  next session, so state is mutated on their machine, not pre-baked here.
- Social layer (asymmetric resources, proposals, self-set goals) is scoped in
  GOVERNANCE_PLAN.md but NOT built yet — that's the next real work now that runs
  start "past caveman."

---

## 2026-07-06 (i) — Add smelt primitive; make the host survive async throws

Run after entry (h) confirmed cobblestone is SOLVED — both bots mine reliably
(Garrick +3/+3/+10/+10/+9; Mason to 29 cobble) and the tech tree flows through
stone tools and furnaces. New wall hit: smelting. The LLM was forced to hand-write
raw `bot.openFurnace(...)` (no smelt helper existed) and crashed the host with an
UNCAUGHT TypeError by passing an undefined furnace block — the same
missing-primitive shape as `acquireStone`/`digStaircaseDown`, now for the furnace.

### What changed
1. **New `helpers.smelt(inputName, count)` primitive.** Does the full furnace
   dance safely: find-or-place a furnace, add fuel (coal/charcoal, else planks/
   logs), insert input, poll the output slot with a bounded wait, take output,
   close. GUARDS the null-furnace case that crashed the runner. Built against the
   REAL mineflayer 4.37.1 furnace API (verified: `putFuel/putInput/takeOutput/
   outputItem`), not from memory. Knows common smelts (cobblestone->stone,
   sand->glass, raw_iron->iron_ingot, log->charcoal).
2. **Host survives async throws.** `uncaughtException` no longer just logs — it
   clears in-flight movement and KEEPS THE HOST ALIVE (added `unhandledRejection`
   too). A throw from inside a mineflayer event callback (e.g. openFurnace's
   progress listener) escapes runSkill's try/catch because it fires on the event
   loop; previously that killed the whole process.
3. **Contract doc.** Documented `smelt` for the LLM; explicitly noted stone_bricks
   are CRAFTED from stone, not smelted (the exact confusion in the log — smelt
   cobblestone->stone THEN craftItem('stone_bricks')).

### Files
- `node_host/bot_host.js` — `smelt` helper; `uncaughtException`/`unhandledRejection`
  recovery.
- `orchestrator/prompts.py` — `smelt` contract entry + stone_bricks note.

### Verified
- Both files parse.
- Furnace API confirmed against installed mineflayer 4.37.1 source
  (`putFuel(itemType,metadata,count)`, `takeOutput()`, `outputItem()`).
- Item names (cobblestone/stone/stone_bricks/charcoal/raw_iron/iron_ingot) confirmed
  against mcData 3.108/1.21.

### Still unverified
- `smelt` not run live. The output-polling loop's timing (waitTicks(20) ≈ 1s,
  bounded deadline) is a first estimate — if smelts report "no output produced in
  time," lengthen the deadline. Watch for `{ok:true, output:'stone', count:N}`.
- Fuel accounting for weak fuels (planks/sticks) is generous-but-approximate; may
  over-consume fuel. Correctness over efficiency for now.
- The concurrent-collect-loop "goal was changed" spin-storm (seen in entry-h run,
  two skills pathfinding at once) is NOT addressed here — still a candidate if
  cycles are being wasted.

---

## 2026-07-06 (h) — Root-cause the cobblestone thrash: let the LLM compose, add an honest dig-down

After ~10 patch iterations on cobblestone mining (and 15 versions of
`mine_cobblestone` on disk), stepped back for the actual root cause instead of
another symptom patch. The mining CODE was mostly fine; the ARCHITECTURE was the
bug. The prompt handed the LLM a monolithic `acquireStone` and told it "THE way to
get cobblestone... do NOT compose your own solution" — collapsing its whole
creative surface to a switch on a status code. When the primitive was crippled
(capped search, 1-block dig-down), the LLM had no lever, so it rewrote the wrapper
endlessly. The two human strategies for getting stone (walk to exposed rock; dig
DOWN through dirt to the stone layer) both existed but were capped into
uselessness by guards added for earlier symptoms.

### What changed

1. **New honest primitive `digStaircaseDown(maxDepth)`.** Digs a safe, climbable
   staircase down until it reaches the stone layer (typically 3-6 blocks on
   plains), hits maxDepth, or stops for a real hazard (lava/water/cavern, reported
   in `stoppedFor`). Replaces the effectively-unusable `_digDownToStone` (dug ONE
   block then gave up). This is the "no rock in sight, so dig down to it" move that
   no prior fix completed.
2. **Freed the LLM to compose.** Rewrote the mining section of `CODE_CONTRACT`:
   `acquireStone` is now documented as a CONVENIENCE, not "THE way"; the LLM is
   explicitly encouraged to compose its own approach and told the human heuristic
   ("stone sits under the dirt; if none exposed, dig down"). Removed the "do NOT
   call findMineableStone/gotoXYZ yourself" prohibition.
3. **Belt-and-suspenders in `acquireStone`.** When no exposed stone is reachable
   (near or far sweep) AND the tool can mine stone, it now falls back to
   `digStaircaseDown(8)` then `collectBlock('stone',count,6)`. So even skills that
   only call the convenience get the real behavior.
4. **Stopped the rewrite loop at its source.** Added mining/terrain reasons ("no
   mineable stone", "no stone here", "all buried", "travel to fresh terrain", etc.)
   to `_ENV_FAIL_MARKERS`, so "no reachable stone" is classified as a WORLD failure
   (property of the map) rather than a code defect — the skill is no longer revised
   for it. This is what breaks the 15-versions thrash.

### Files
- `node_host/bot_host.js` — `digStaircaseDown`; `acquireStone` dig-down fallback.
- `orchestrator/prompts.py` — `CODE_CONTRACT` mining section rewrite.
- `orchestrator/runner.py` — mining reasons added to `_ENV_FAIL_MARKERS`.

### Verified
- Both files parse (node --check, py_compile).
- **Against real mcData 1.21.1:** confirmed `wooden_pickaxe` (id 820) IS in
  `stone.harvestTools` → wood mines stone. So the prior `need_tool` on a
  wooden-pickaxe bot was the old mislabel (fixed in entry e), and the new dig-down
  fallback (gated on `!r.tool_blocked`) WILL fire for a wooden-pickaxe bot on
  plains and reach stone.
- Traced Garrick's cycle-8 failure end-to-end through the new path; it completes
  (dig down ~4 dirt → hitStone → collectBlock → cobblestone).

### Still unverified
- Not run live yet. Watch for `viaDigDown:true` / "digging a staircase down to the
  rock layer" in the next log to confirm the behavior fires.
- Whether `digStaircaseDown`'s pathfinder step-down (`GoalNear(...,0)`) reliably
  moves the bot into each cut step, or whether the manual `forward` nudge fallback
  ends up doing the work. If dig-down stalls, that's the first place to look.
- No "travel to a stone biome" behavior still exists; if a spawn is stone-starved
  AND shallow-dig hits only more dirt/sand for 8 blocks, the bot still can't get
  stone. digStaircaseDown makes plains work; it doesn't solve a genuinely
  stoneless locale.

---

## 2026-07-06 (g) — Pathfinder reach vs. search: fix "stone visible but unreachable"

Screenshot evidence (bots on a flat plains, only stone a distant cliff) exposed an
internal contradiction: `findMineableStone` searched for stone up to 96 blocks
(far sweep) but `bot.pathfinder.searchRadius` was capped at 48. So stone located
past 48 blocks was handed to a planner that structurally could not path that far →
guaranteed "No path to the goal" on stone the bot could see. Constants set in
earlier rounds to fight pits/timeouts had collectively boxed the bots into a
mining bubble the terrain didn't fill.

### What changed
1. **`searchRadius` 48 → 128.** Must exceed the finder's 96-block far sweep;
   otherwise the planner rejects stone the finder already located. Root cause of
   "stone visible but unreachable" on open terrain.
2. **`maxDropDown` 1 → 3.** Was 1, which forbade stepping DOWN a cliff/hillside
   face — exactly where exposed surface stone is. 3 lets the bot descend to rock
   without committing to a deep unrecoverable plunge.
3. **Diagnostic logging** at the far sweep (`far-sweeping to N`, `reached stone at
   X,Y,Z`, `FAILED status=... reason=...`) so the next run shows the geometry the
   summaries hid.

### Files
- `node_host/bot_host.js` — pathfinder config (`searchRadius`, `maxDropDown`);
  far-sweep diagnostic logs.

### Verified
- Parses. searchRadius (128) now > far-sweep reach (96) > near reach (32) —
  internally coherent.

### Still unverified
- Whether reaching the cliff then mines successfully, or hits a further problem.
- Whether bots choose to travel that far before the 4-attempt limit blocks
  `obtain_stone`. (Largely superseded by entry h's dig-down, which avoids needing
  the distant cliff at all.)

---

## 2026-07-06 (f) — Stop getUnstuck building sky towers; distinguish buried vs. surface

Screenshots showed bots stranded on 5+ block dirt pillars with crafting tables on
top. Cause was a compounding of entry-e's own fix: `getUnstuck`'s pillar-up tier
(valid only when buried underground) was firing on SURFACE trenches, and the new
mobility-triggered `getUnstuck` call inside `acquireStone` invoked it routinely.
Once perched on a tower, entry-e's `placeAt` floor-check saw the tower top as
"solid ground" and approved a table there. Two correct-in-isolation fixes combined
into a tower-building machine. Owned as my (assistant's) regression.

### What changed
1. **Sky probe in `computeMobility`** (`openSkyAbove`, `ceilingAt`): scan straight
   up to tell "buried underground" (pillar valid) from "surface trench" (pillar
   forbidden).
2. **Gated pillar tier**: `getUnstuck` Tier 3 only pillars when genuinely buried
   (`!openSkyAbove`). New Tier 3b for surface: dig sideways through the wall and
   walk to open ground, placing NO blocks. Tier 4 (mine-up) skipped when sky is
   already open.
3. **Disabled pathfinder auto-towering** (`allow1by1towers = false`) so the
   planner can't build stray pillars while routing.
4. **Prompt hygiene**: reframed `pillarUp` as underground-escape-only and told the
   LLM not to pillar on the surface; documented that `placeAt` needs ground.

### Files
- `node_host/bot_host.js` — `computeMobility` sky probe; `getUnstuck` tier gating +
  Tier 3b; `allow1by1towers`.
- `orchestrator/prompts.py` — pillarUp/placeAt guidance.

### Verified
- Parses. Pillar (buried) and dig-out (surface) tiers are mutually exclusive via
  `openSkyAbove`.

### Still unverified
- Whether the 16-block up-scan height for `openSkyAbove` suits all terrain; if a
  surface bot still logs `method:'pillar'`, that height is wrong.
- Pre-existing towers/tables aren't removed (can't verify live-world coords from
  the archive); code only prevents NEW ones.

---

## 2026-07-06 (e) — Fix need_tool misreport + floating structures + trench freeze

First pass on this session's bug reports. Three distinct issues.

### What changed
1. **`need_tool` misreport.** `collectBlock` stamped `tool_blocked` even when
   failures were unreachability/none-found, so `acquireStone` emitted "craft a
   pickaxe" and the critic confabulated durability/equip LESSONS that poisoned
   future generation. Gated `tool_blocked` to genuine, reachable tier failures
   (`trueToolBlock`: `toolBlocked>0 && dug===0 && softFails===0 && !noneFound`).
2. **Floating structures.** `placeAt` would anchor a block against ANY solid face,
   including a side face in mid-air — how bots built dirt/chest towers into the
   sky. Now requires solid ground directly below by default; walls/pillaring pass
   `{allowFloating:true}` but still need an anchor.
3. **Trench freeze + wider relocation.** `acquireStone` now repositions (getUnstuck
   + `stepToOpenGround`) before searching, and adds a far relocation sweep
   (3×range, min 96) so a strip-mined home area triggers travel instead of
   dead-ending.
4. **Lesson-loop hygiene** (runner): suppress lesson-writing when the whole cycle
   failed environmentally; purged 6 poisoned tool lessons + 7 blackboard notes;
   reset the `obtain_stone` capability block.

### Files
- `node_host/bot_host.js` — `collectBlock` gating; `placeAt` floor check;
  `acquireStone` reposition + far sweep; `stepToOpenGround`.
- `orchestrator/runner.py` — env-failure lesson suppression.
- `state/*.json` — one-time cleanup of poisoned lessons/notes/capability.

### Verified
- Parses. Lesson suppression and capability reset confirmed in state files.

### Still unverified
- Fixes 2 and 3 interacted badly (surface pillaring) — corrected in entry f.
- Whether relocation actually reaches distant stone — the searchRadius mismatch
  wasn't caught until entry g.

---

## 2026-07-06 (c) — Shared home memory: route crafting to a Mason-sited workshop

The 7-tables-in-a-cluster problem was two stacked causes: (1) the table bug made
crafts fail *after* placing a table, so every retry placed another (fixed in entry
b), and (2) the bots never consulted the persistent, global workshop/home registry
when deciding whether to build a table — the node helper layer couldn't see it.
This entry gives the tested helpers access to the shared "where home is" memory and
routes crafting there, so infrastructure clusters at one center. Aligns with the
project goal: the LLM decides WHERE home is; the code only enforces "go home rather
than scatter."

### What changed

1. **World context now reaches the node helpers.** `runner` passes the established
   workshop coords + decider flag out-of-band on every `run_skill`
   (`bot_bridge.run_skill(..., context=...)` → node `_worldContext`). Previously
   only skill *code* saw `WORKSHOP` as a const; the tested `craftItem` helper was
   blind to it. This is the Option-B plumbing: the authoritative, persistent
   registry (Python) is now readable by the primitives that act on it (node).

2. **`craftItem` routes to home before placing a loose table.** New order: table
   right here → walk to the community HOME/workshop and craft/seed a table there →
   nearest table in a wide (64) radius → LAST RESORT temporary table where we
   stand. Tested all four branches in isolation (reuse-home / seed-home /
   unreachable-home / no-home-yet).

3. **Mason sites home proactively.** The decider was only nudged to establish the
   workshop after 4 cycles of an active starvation signal — which never fired in
   fast runs, so home stayed null forever and tables scattered. The decider prompt
   now asks him to CHOOSE and establish home early (within the first few cycles,
   once basic tools exist). Location choice remains 100% his LLM judgment
   (`goodSiteHere()` + reasoning); only the TIMING of the ask changed. Future work:
   electing/rotating the decider (still hardcoded to Mason).

4. **Temp-table observability.** When craftItem must drop a stopgap table (home
   unreachable / not yet sited), the run result carries `placedTempTable:true`.
   Purely for watching how often home-routing fails — the registry still records
   real tables honestly (hiding them would make the map lie); the cure for
   scattering is routing to home, not suppressing records.

### Files

- `node_host/bot_host.js` — `_worldContext`, `_lastCraftPlacedTempTable`;
  craftItem home-routing; result surfaces `placedTempTable`.
- `orchestrator/bot_bridge.py` — `run_skill(context=...)`.
- `orchestrator/runner.py` — pass workshop/decider context to run_skill.
- `orchestrator/structures.py` — decider prompt sites home proactively.

### Verified (in isolation)

- craftItem decision tree: routes to home when home has a table (no duplicate),
  seeds one when home is empty, falls to a flagged temp table only when home is
  unreachable or unsited.

### Still unverified (watch on next run)

- **Does Mason actually site home early, and do tables then cluster?** The whole
  point — only a live run shows whether the proactive prompt produces an
  `establish_workshop` and whether `structures.json` stops accumulating scattered
  tables. Count tables after a run.
- **`placedTempTable` rate.** If it's high, home routing is failing (unreachable
  home or unsited) and needs a look.

### KNOWN ISSUE surfaced by this run, NOT yet fixed (next session)

- **`acquireStone` fails on buried-stone terrain.** At Y=64-66 with no exposed
  rock, Garrick got `status:need_tool` / `blocked` despite holding a wooden pickaxe
  (which CAN mine stone), and Mason only got cobblestone by accidentally digging
  through dirt over a 90s timeout. One relocation isn't enough, and buried stone
  returns `blocked` instead of triggering a staircase dig-down. Deliberately left
  for its own session so the fix can be targeted against a log that breaks down the
  `all_buried` vs `need_tool` status counts — bundling it here risks another
  two-layers-down surprise.

---

## 2026-07-06 (b) — Fix table-detection regression + capability misclassification

First clean run on the new code (world reset, fresh state). The species fix held
(no cherry_planks demands anywhere in a 45-min log), but a regression I introduced
in the previous entry surfaced, plus a classifier edge case.

### What changed

1. **Fixed a table-detection regression in `_rankRecipes`.** Every table-requiring
   craft (wooden pickaxe) failed with "Recipe requires craftingTable, but one was
   not supplied" for ~40 minutes. Cause: my new `_rankRecipes` always fell back to
   `recipesAll` (inventory-ignoring), so the initial `table=null` probe in
   `craftItem` never returned empty — which is the signal that drives the
   table-acquisition branch. It got skipped, `table` stayed null, and `bot.craft`
   was called with no table. Fix: added an `includeUncraftable` flag (default
   false = STRICT). The two probes in `craftItem` use strict (empty ⇒ "need a
   table"); only `_missingFor` passes true (it needs a shape to diff). Verified
   with a table-gate test: null probe returns [], table branch runs, craft
   supplies the table.

2. **Fixed capability misclassification of "using the crafting table".** The
   tracker printed `craft_crafting_table is now BLOCKED` when the real failing
   task was "craft a wooden pickaxe using the nearby crafting table" — the generic
   table rule matched before the pickaxe rule. Fix: treat "using/at/near the
   crafting table" as an INSTRUMENT phrase (stripped before matching, like "using
   a stone pickaxe"), and reordered rules so specific end-items match before the
   generic table rule. The table rule now only fires when the table itself is the
   goal.

### Observations logged but NOT yet acted on (design calls for you)

- **BLOCKED warnings compete with structured nudges and can lose.** The tracker
  correctly flagged `craft_wooden_pickaxe` blocked at cycle 6, but the proposer
  kept proposing it (cycles 7-22) because the bootstrap block + goal ladder still
  (correctly, given the bug) pointed at the pickaxe. With the table bug fixed this
  specific case resolves, but the general issue stands: a broken-capability
  warning is advisory text competing with signals that don't know the capability
  is broken. Optional stronger fix (not done): have the proposer SUPPRESS the
  bootstrap/goal nudge for a currently-blocked capability so the signals stop
  contradicting. This takes autonomy from the LLM — deferred pending a decision.
- **`collect_oak_log` succeeds by luck, swallowing an error.** Cycle 17 logged
  "Failed to collect log: unknown error" then `oak_log+1` then success. Same
  silent-helper-failure class as the old run, lower frequency. Worth watching.

### Files

- `node_host/bot_host.js` — `_rankRecipes` gains `includeUncraftable`; `_missingFor`
  passes true.
- `orchestrator/capabilities.py` — instrument-phrase strip extended to crafting
  table; rule order fixed.

### Still unverified (check first if next run misbehaves)

- Confirm the first live wooden-pickaxe craft now succeeds end to end (place table
  → walk to it → craft). The isolated test passes; the live table-placement +
  pathfinding step is the part only a real run exercises.
- `acquireStone` on real terrain (unchanged from prior entry — not yet exercised
  in a run that got far enough to need stone).

---

## 2026-07-06 (a) — Fix crafting/stone helper bugs; add capability-health learning

Two helper bugs were generating most of the failure volume in the logs, and the
"learning" machinery was pointed at the wrong layer so it couldn't compound. This
session fixes the bugs and adds a derived, decision-gating learning signal.

### What changed

1. **Recipe resolution now picks the species the inventory actually covers.**
   `craftItem` / `_missingFor` were reading `recipesAll(...)[0]` — the first wood
   species by item-id (cherry in this world) — and reporting e.g. "missing 3
   cherry_planks" while the bot held 9 oak_planks. Added `_rankRecipes`, which
   orders every recipe variant by inventory coverage and picks the best; both
   `craftItem` and `_missingFor` now use it. `craftItem` also verifies the item
   actually entered inventory before returning `ok:true` (kills the "success log
   but no inventory change" false positives the critic kept catching).

2. **One reliable stone primitive with typed outcomes.** Every `mine_cobblestone`
   revision (67 of them) used `findMineableStone(16)` then `gotoXYZ(pos.x,...)` —
   but that helper returns an always-truthy object that *already traveled*, with
   coords under `.movedTo`, not `.x`. So `!pos` was never true and
   `gotoXYZ(undefined,...)` produced "Path failed" forever. Fixed the return
   contract (coords at top level + note that it already traveled) and added
   `acquireStone(count)`, which does the mechanical work and returns a STATUS
   (`got` / `need_tool` / `all_buried` / `no_stone_here` / `blocked`) so the LLM
   decides the next move instead of the helper deciding silently. Contract +
   RULES in prompts.py now steer new code to `acquireStone` for stone.

3. **Capability-health tracker (new `capabilities.py`).** Free-text lessons are a
   weak signal — they inform the model but gate nothing, so the proposer kept
   re-deriving dead subgoals. New module records per-*capability* (not per-skill)
   success/failure; after 3 consecutive failures a capability is surfaced to the
   proposer as BLOCKED with a directive to pursue the prerequisite or switch
   branches. Auto-recovers on one success. Mirrors the existing inventory-derived
   `bootstrap_block` pattern (derived, structured, decision-gating).

4. **Retirement ceiling + lesson trims.** `retire()` is now actually called: a
   skill revised `MAX_SKILL_REVISIONS` (4) times and still failing is retired
   instead of rewritten again (was the 67x churn). Lessons capped tighter (40→20
   stored, 15→8 injected, dedup threshold 0.5→0.4) so the weak signal stops
   drowning the strong structured ones.

### Why

The abstraction boundary was inverted: strategy decisions (dig down vs. relocate,
when to give up) were frozen inside helpers where the LLM couldn't override them,
while genuine MC-reality primitives (guarantee-a-drop, resolve-a-recipe) were the
flaky ones. Fixes move decisions back to the LLM and make the primitives reliable.

### Files

- `node_host/bot_host.js` — `_rankRecipes`, `_recipeNeeds`, `_recipeShortfall`,
  `acquireStone`; rewired `craftItem`, `_missingFor`, `findMineableStone`.
- `orchestrator/capabilities.py` — NEW. Goes in `orchestrator/` (Python module,
  sibling of goals.py/lessons.py).
- `orchestrator/runner.py` — import + record capability outcomes; retirement ceiling.
- `orchestrator/prompts.py` — contract/RULES for `acquireStone`; render broken block.
- `orchestrator/lessons.py` — tighter caps/dedup.
- `orchestrator/config.py` — added `MAX_SKILL_REVISIONS = 4`.

### Verified (in isolation)

- Recipe ranker: reproduced the "9 oak_planks → missing 3 cherry_planks" bug and
  confirmed the fix reports the pickaxe as craftable-now.
- Capability classifier / broken-detection / recovery: all pass, incl. stripping
  tool-instrument phrases ("mine coal using a stone pickaxe" → `mine_coal`, not stone).
- All files syntax-clean; new helpers confirmed inside the `helpers` object literal.

### Still unverified (check these first if the next run misbehaves)

- **The first live craft.** `_rankRecipes` reads the `delta` shape from
  `bot.recipesFor`; confirm on mineflayer 4.37 that the first wooden-pickaxe craft
  from freshly gathered logs actually succeeds. If it still names a missing plank
  species, look here first.
- **`acquireStone` on real terrain.** It relocates once; confirm that's enough on
  your world, or whether the model needs to chain a dig-down after `all_buried`.
- Fresh-world runs use a new seed, so results aren't directly comparable to the old
  logs unless the same `level-seed` is set. Old `logs/`, `skills/working/`, `state/`
  were backed up before the clean-slate reset for baseline comparison.

## v14 — The build instructions were never reaching the coder (the real root cause)

**Symptom (many runs):** structures came out incoherent — roofs placed one course
above walls that weren't tall enough to hold them, 95 placements driven into solid
dirt (`"placement didn't stick"`, `"no solid block adjacent — it would float"`), the
same failing coordinate retried over and over, half-built shelters abandoned and
marked done. Previous passes tried to fix this by *strengthening the wording* of the
build instructions. Nothing changed, and the fixes kept getting re-litigated.

**Root cause: a prompt-plumbing gap, not a disobedient model.** All the build
guidance lived in `structures.purpose_block()`. That string was injected into
`prompts.propose_prompt()` — and *only* there (`runner.py:303, :324`).
`prompts.code_prompt()` had no parameter for it and never received it.

So the model that actually **writes the placement coordinates** had never been told:
- that `helpers.groundY(x,z)` exists,
- that `surfaceHeights` is indexed by **offset from the bot**, not world coords
  (doing math on it is what put blocks inside terrain),
- that blocks can't float and you build ground-up,
- that `placeAt`/`buildBlocks` *report why* a cell failed and you must react,
- that `spatialMap` is in its game state at all.

It received: the task string, a JSON state dump, and `CODE_CONTRACT`. And
`CODE_CONTRACT` had an imperative rule for **every other verb** — "To GATHER… use
`collectBlock`", "To CRAFT… use `craftItem`", "To GATHER STONE… use `acquireStone`" —
but **no rule for building at all**. `buildBlocks` and `groundY` were described in the
API list and never once prescribed. An uninstructed model, handed a grid of Y numbers
in its state dump, does the obvious thing: hardcodes a Y and loops `placeAt`. That is
exactly what the logs show. It was never disobeying — it was never briefed.

Second gap, same shape: `critic_prompt` tells the critic to *"use the block-census /
spatialMap evidence"* to judge whether a build advanced the structure — but the slim
slice it was handed contained `nearbyBlockCensus` and **not** `spatialMap`. The critic
was asked to grade geometry from a field it could not see, so it fell back to "some
blocks moved = success". That verdict is what marks a plan slot BUILT, which is how
roofless walls got declared finished and abandoned.

### Changes

- **`structures.py` — split `purpose_block()` in two.** It was doing two unrelated
  jobs and being routed to the one model that could act on neither.
  - `purpose_block()` — **GOALS only** (what a shelter/wall/storage is FOR, when a
    slot is really done). Goes to the **proposer** and now also the **critic**.
  - `build_mechanics_block()` — **MECHANICS only** (groundY vs. grid math,
    `buildBlocks` as the build verb, ground-up physics, read the `failures[]` reason,
    read `spatialMap`). Goes to the **coder**.
- **`prompts.py::code_prompt`** — new `build_rules` param, injected after the state
  dump (closest to generation). The coder finally sees the build rules.
- **`prompts.py::CODE_CONTRACT`** — added the missing imperative:
  `TO BUILD ANY STRUCTURE … use helpers.buildBlocks(cells, name)`, never a hand-rolled
  `placeAt` loop, never arithmetic on `surfaceHeights`.
- **`prompts.py::critic_prompt`** — new `structure_goals` param, and the before/after
  slices now actually carry `spatialMap` (grid + legend + origin; the
  `surfaceHeights` matrix is dropped to keep the payload small). The critic can now
  diff the two top-down grids to see what the run really built.
- **`runner.py`** — passes `structures.build_mechanics_block()` into `code_prompt`
  (`:395`) and `structures.purpose_block()` into both `critic_prompt` call sites
  (`:455`).
- **`purpose_block()` also now tells the proposer to write a CONCRETE task** — shape,
  footprint, anchor coords, and which part this cycle builds. The coder sees *only*
  `task` + `success_looks_like`; it cannot see the proposer's reasoning, the village
  plan, or the goals text. "Continue the shelter" is unbuildable; "build the 5x5
  shelter walls at (-104,-78), 2 courses on the existing floor, 1-block door gap
  south" is.

No blueprints were hardcoded. The LLM still designs every structure — it is now
merely *told the physics and given the map*, which is category (A)/(B) under the
fidelity rule in `GOVERNANCE_PLAN.md` (Minecraft truth + mechanical execution), not
category (C) strategic choice.

### How to falsify this (do this before believing it)

Run and watch `logs/Mason.log`:
- generated build code should now call `helpers.groundY(...)` and/or
  `helpers.buildBlocks(...)` instead of a `placeAt` loop over hardcoded Y values;
- `place_did_not_stick` / `no_support_neighbour` failures should collapse;
- the critic's `reason` on a partial build should start citing the enclosure/gap
  rather than the block count.

If the coder **still** hardcodes Y after this, the diagnosis was wrong and the next
place to look is whether the task strings from the proposer are too vague to build
from at all (i.e. the design decision is being lost between the two models, not the
physics).

## v14.1 — 400 Bad Request storm on the critic endpoint (regression from v14)

**Symptom:** immediately after v14, EVERY critic call to `.126:8888` failed with
`400 Client Error: Bad Request`, 3 attempts each, then `GAVE UP`. Every verdict came
back `success=False conf=0.2 — critic could not be parsed twice`. The actor endpoint
(`.128`) was fine. Not intermittent: deterministic, every call.

**Cause: I overran the critic's context window in v14.** A 400 is the server
*rejecting* the request, not failing it. Three compounding factors:

1. `llm.critic()` set no `max_tokens`, so it inherited `_chat`'s default of **2048** —
   reserving 2048 tokens of context for a reply that is one small JSON verdict
   (~60-100 tokens).
2. v14 added `spatialMap` to the critic's before/after slices — including the ~400-char
   `note` field and a duplicate copy of the legend, twice over.
3. v14 also injected the full `purpose_block()` (~2.5k chars, written for the proposer).

Together that pushed the request to ~2350 input + 2048 reserved output ≈ **4400 tokens**,
past a small-context critic (Gemma at `--max-model-len 4096`). vLLM rejects the whole
call. Now ~1920 in + 256 out ≈ **2180**, with ~1.9k tokens of headroom.

**Why it took so long to see:** `llm.py` caught `RequestException` and logged only
`str(e)[:120]` — which yields the generic `"400 Client Error: Bad Request for url: ..."`
and **discards the response body**, where vLLM states the actual reason ("maximum
context length is 4096 tokens, however you requested 4398"). Any prompt-too-long bug
was undiagnosable by design.

### Changes

- **`llm.py::_chat`** — on an HTTP error, log the server's response body
  (`server said: ...`). Also: **do not retry 4xx.** A malformed/over-length request is
  rejected identically every time; retrying it 3× with backoff just triples the noise
  and the latency. Fail fast. (5xx and timeouts still retry as before.)
- **`llm.py::critic`** — `max_tokens` defaults to **256**, not 2048. The critic emits
  one small JSON object; the 2048 reservation was pure dead weight against the window.
- **`prompts.py::critic_prompt`** — trimmed the payload: send `spatialMap` as
  `{origin, grid}` only (drop the coder-facing `note` and the `surfaceHeights` matrix),
  and send the legend ONCE (it's identical before/after) instead of twice.
- **`structures.py`** — new `critic_goals_block()`: the short form of `purpose_block()`,
  sized for the small model. States what each structure TYPE must achieve and nothing
  else. `runner.py` now passes this to the critic instead of the full proposer essay.

### Note on the other warning in that log

`SLOW mechanical call [code-gen] took 45-62s (threshold 35s)` on `.128` is a
**separate, pre-existing** issue and is not caused by v14 — it's 4 bots × concurrent
code-gen against one actor endpoint. It's GPU pressure, not a bug. Per
`GOVERNANCE_PLAN.md` Part C the lever is more actor endpoints (or a smaller actor
model); `MAX_CONCURRENCY` in `config.py` is the cheap knob meanwhile. v14's build-rules
block does add ~800 tokens to each code-gen prompt, which will make this marginally
worse — worth watching, but the actor's window is large and it is not near it.
