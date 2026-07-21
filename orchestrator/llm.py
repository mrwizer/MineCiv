"""llm.py — thin OpenAI-compatible clients for the two local machines.

ACTOR  = V100 / Qwen  : proposes tasks, writes & debugs mineflayer code.
CRITIC = Mac  / Gemma : judges success from before/after game state.
Tokens hardcoded per user request (local-only testing).
"""
import json
import re
import threading
import time

import requests

# --- ENDPOINTS ---------------------------------------------------------------
# Each endpoint dict describes one model-serving box. Fields:
#   url, key, model  — the OpenAI-compatible endpoint, its token, served name.
#   server           — "llamacpp" or "vllm". This ONLY affects how thinking is
#                      controlled per request: llama.cpp honors `reasoning_budget`
#                      to cap a reasoning trace; vLLM does NOT accept that field and
#                      can 400 on it, so we never send it to vLLM. Both honor
#                      chat_template_kwargs.enable_thinking to turn thinking OFF.
#   no_think         — endpoint default for reasoning (False = reason by default).
#   concurrency      — optional per-box in-flight cap (else MAX_CONCURRENCY).
#   critic_think     — optional override used ONLY when this box acts as a CRITIC:
#                      set False on a REASONING box so self-critique emits its small
#                      JSON verdict directly instead of spending the tiny token
#                      budget on a <think> trace (which would yield no parseable
#                      verdict). Absent on Gemma so its behavior is unchanged.
#
# The original two boxes are UNCHANGED (server "llamacpp"). The four new boxes are
# vLLM/qwen3.6-35b and each serves BOTH the actor role AND self-critique for its
# own ~4 bots (see config.py). All new boxes share the existing API token.

# Secrets + box addresses live in local_settings.py (git-ignored). On a fresh
# checkout that file won't exist yet, so fall back to the committed example
# (placeholders) and warn — the code still imports; it just won't reach real servers
# until you `cp local_settings.example.py local_settings.py` and fill it in.
try:
    import local_settings as _cfg
except ImportError:
    import local_settings_example as _cfg  # type: ignore
    print("[llm] WARNING: local_settings.py not found — using placeholder endpoints. "
          "Copy local_settings_example.py to local_settings.py and add your tokens/URLs.")

VLLM_KEY = _cfg.VLLM_KEY   # shared token, all vLLM boxes

ACTOR = {
    "url": _cfg.ACTOR_URL,
    "key": _cfg.ACTOR_KEY,
    "model": _cfg.ACTOR_MODEL,           # llama.cpp --served-model-name
    "server": "llamacpp",
    # The actor box serves Qwen2.5-Coder-14B (the fast "hands"). We WANT it to just
    # write code, no <think> trace — but this GGUF's chat template DOES support thinking
    # and was emitting an unclosed <think> trace on complex prompts that llama.cpp routed
    # into `reasoning_content`, leaving `content` empty (finish=length, 0-char code). So
    # `reasoning:True` here means "understands the thinking toggle": since code-gen is not
    # in THINKING_LABELS, _chat sends `enable_thinking:False` to SUPPRESS the trace so the
    # code lands in `content`. (llama.cpp ignores the kwarg if the template doesn't use
    # it, so this is safe either way.) Belt-and-suspenders: also start its llama-server
    # with `--reasoning-format none`.
    "reasoning": True,
    "no_think": True,
}
CRITIC = {
    "url": _cfg.CRITIC_URL,
    "key": _cfg.CRITIC_KEY,
    "model": _cfg.CRITIC_MODEL,      # Mac now serves Qwen3.5-9B (a reasoning model)
    "server": "llamacpp",
    # Qwen3.5-9B is a REASONING model, so `reasoning:True` lets _chat send the
    # `enable_thinking` control — but `critic_think:False` turns thinking OFF for the
    # verdict: a judge should emit its small JSON directly, not spend the token budget
    # on a <think> trace (that was the "no JSON found" parse failure). Judging is still
    # a reasoning task; a modern 9B does it well without an explicit trace.
    "reasoning": True,
    "critic_think": False,
}

# --- STRATEGIST: the single big reasoning model (DGX) shared by ALL bots ------
# The "mind" of the society. Every bot's rare, high-value reasoning calls (strategy,
# design, lesson, and the future governance/policy/dispute labels) route HERE via
# STRATEGIST_LABELS below — NOT per-bot binding — so there is ONE coherent strategic
# mind for the whole community, on the biggest model we can run. It is latency-tolerant
# (these calls are rare; continuations skip most propose calls), which is exactly why a
# slow-but-smart 122B fits. Thinking is ON for its reasoning labels (see THINKING_LABELS).
STRATEGIST = {
    "url": _cfg.DGX_URL,
    "key": VLLM_KEY,
    "model": _cfg.DGX_MODEL,         # vLLM --served-model-name (Intel AutoRound int4)
    "server": "vllm",
    "reasoning": True,
    # Higher in-flight cap than the default: one box now fields strategy for all 20
    # bots, and the A10B MoE + vLLM continuous batching handle concurrency well. Tune
    # down if the DGX queues; strategy is rare so this is usually ample headroom.
    "concurrency": 8,
}

# Registry: config.py refers to boxes by these ids; runner binds each bot to its
# actor/critic endpoint (thread-local). The STRATEGIST is not per-bot bound — it is
# label-routed (see _actor_ep_for), so all bots share the one mind.
ENDPOINTS = {
    "actor":      ACTOR,
    "critic":     CRITIC,
    "strategist": STRATEGIST,
}

def get_endpoint(endpoint_id):
    """Resolve an endpoint id (as used in config.BOTS) to its endpoint dict."""
    ep = ENDPOINTS.get(endpoint_id)
    if ep is None:
        raise KeyError(f"unknown endpoint id {endpoint_id!r}; "
                       f"known: {sorted(ENDPOINTS)}")
    return ep

# --- per-thread endpoint binding --------------------------------------------
# Each bot runs in its own thread and calls llm.actor()/llm.critic() from there.
# Binding the endpoints thread-local means those calls automatically route to the
# BOX THIS BOT OWNS, with no change to the many call sites in runner.py. Unbound
# threads (e.g. setup_check) fall back to the original ACTOR/CRITIC defaults.
_tls = threading.local()

def bind_endpoints(actor_ep, critic_ep):
    """Bind the actor + critic endpoint for the CURRENT thread. Call once at the
    top of each bot's thread. actor_ep / critic_ep are endpoint dicts (resolve via
    get_endpoint)."""
    _tls.actor = actor_ep
    _tls.critic = critic_ep

def _actor_ep():
    return getattr(_tls, "actor", ACTOR)

def _critic_ep():
    return getattr(_tls, "critic", CRITIC)

# --- label routing: MIND vs HANDS -------------------------------------------
# The actor role is split by LABEL across two machines. The rare, high-value REASONING
# calls go to the shared STRATEGIST (big DGX model); the frequent MECHANICAL calls stay
# on the fast per-thread coder actor (V100). This is the whole architecture: a giant
# brain for strategy/society that can afford to be slow because it's called rarely, and
# a fast coder for the hot code-gen path. Add future society labels (governance, policy,
# dispute, trade) here to route them to the mind too.
STRATEGIST_LABELS = {"strategy", "strategy-retry", "design", "lesson",
                     "governance", "policy", "dispute", "trade"}

def _actor_ep_for(label):
    """The endpoint an actor call with this label should use: the shared STRATEGIST for
    reasoning labels, else the thread-bound coder actor."""
    return STRATEGIST if label in STRATEGIST_LABELS else _actor_ep()

TIMEOUT = 300  # actor box (.128) also runs the MC server, so allow extra headroom

# --- per-endpoint concurrency gate ------------------------------------------
# Unsloth Studio (via vLLM/HF) does CONTINUOUS BATCHING: it packs multiple
# in-flight requests into one GPU stream, processing them token-by-token together.
# So the server WANTS concurrent requests — the old "one request at a time" lock
# actively defeated that, forcing bots to queue when the box could have batched
# them. We now allow up to MAX_CONCURRENCY requests per endpoint at once (a
# semaphore, not an exclusive lock), which is what lets N bots share one box.
# It's still BOUNDED so a runaway can't open unlimited sockets and blow out the
# KV cache — pick a value the GPU can hold without latency collapse.
MAX_CONCURRENCY = 4         # llama.cpp with `-np 4 -cb` (continuous batching) serves
                            # 4 slots and batches fine on Volta (unlike vLLM's Volta
                            # GPTQ kernel, which collapsed under concurrency). Match the
                            # slot count so no bot starves and no slot sits idle. If you
                            # switch back to vLLM-on-Volta, drop this to 2.
MAX_ATTEMPTS = 3             # network/5xx retries before giving up
RETRY_BACKOFF = 4.0         # seconds, multiplied by attempt number

# Cap the reasoning trace length on think=True calls. Qwen3.x A3B reasons well but
# will happily spend 70s+ generating a long <think> trace for a simple strategy
# decision. This bounds the trace so strategy stays snappy while still reasoning.
# Sent per-request as `reasoning_budget` (llama.cpp honors it); the server's global
# --reasoning-budget is a backstop. -1 = unlimited, 0 = no thinking, N = token cap.
REASONING_BUDGET = 2000

_gates = {}                  # url -> {"sem": Semaphore}
_gates_lock = threading.Lock()

# --- observability: track LLM health so overload is visible BEFORE it breaks ----
# As concurrency rises, the first symptom of an overloaded box is SLOW calls and
# RETRIES, not outright failure. Counting these lets you see trouble coming (and
# tune MAX_CONCURRENCY) instead of being blind until calls start hard-failing.
_stats_lock = threading.Lock()
_stats = {}                  # url -> {calls, retries, timeouts, failures, total_s, slow}
_label_stats = {}            # label -> {calls, total_s, slow} — which call TYPE is slow
# Slow-call thresholds are DIFFERENT by call type. A reasoning (strategy) call
# legitimately takes a long time — it generates a whole think-trace — so flagging
# it at 30s is just noise. A mechanical call (code-gen, revision, naming) should be
# fast; if IT is slow, that's a real signal of concurrency/GPU pressure worth acting
# on. So: generous budget for reasoning, tight budget for mechanics.
SLOW_REASON_S = 120.0        # reasoning/strategy call slow only past this
SLOW_MECH_S   = 35.0         # mechanical (code-gen/etc) call slow past this
# Per-label stats so you can SEE which kind of call is slow, not just "a call".

# Optional hook the runner sets so per-endpoint warnings reach the per-bot log.
# Signature: _log_hook(message:str). If None, we fall back to print().
_log_hook = None
def set_log_hook(fn):
    global _log_hook
    _log_hook = fn

def _emit(msg):
    (_log_hook or print)(f"[llm] {msg}")

def _bump(url, **deltas):
    with _stats_lock:
        s = _stats.setdefault(url, {"calls": 0, "retries": 0, "timeouts": 0,
                                    "failures": 0, "total_s": 0.0, "slow": 0})
        for k, v in deltas.items():
            s[k] += v

def _bump_label(label, dt, slow, ptoks=0):
    with _stats_lock:
        s = _label_stats.setdefault(label, {"calls": 0, "total_s": 0.0, "slow": 0,
                                            "ptoks": 0})
        s["calls"] += 1; s["total_s"] += dt; s["slow"] += (1 if slow else 0)
        s["ptoks"] += ptoks

def _est_prompt_tokens(messages):
    """Cheap prompt-size estimate (~4 chars/token) so we can SEE which call type is
    driving the token bill — no tokenizer dependency, good enough for tracking the
    effect of prompt-trimming. For an EXACT count, POST the concatenated content to
    the llama.cpp /tokenize endpoint; this heuristic is for continuous logging."""
    return sum(len(m.get("content", "") or "") for m in messages) // 4

def stats_snapshot():
    """Return a copy of per-endpoint stats for periodic logging by the runner."""
    with _stats_lock:
        return {u: dict(v) for u, v in _stats.items()}

def stats_line():
    """One-line health summary across endpoints, e.g. for end-of-cycle logging."""
    snap = stats_snapshot()
    if not snap:
        return "llm: (no calls yet)"
    parts = []
    for url, s in snap.items():
        box = url.split("//")[-1].split(":")[0]     # just the IP, for brevity
        avg = (s["total_s"] / s["calls"]) if s["calls"] else 0
        parts.append(f"{box}: {s['calls']} calls, {avg:.1f}s avg, "
                     f"{s['retries']} retries, {s['timeouts']} timeouts, "
                     f"{s['failures']} failed, {s['slow']} slow")
    return "llm health — " + " | ".join(parts)

def stats_by_label():
    """Per-call-type timing: which KIND of call is slow (strategy vs code-gen etc)."""
    with _stats_lock:
        out = []
        for label, s in sorted(_label_stats.items()):
            avg = (s["total_s"] / s["calls"]) if s["calls"] else 0
            avg_t = (s["ptoks"] / s["calls"]) if s["calls"] else 0
            out.append(f"{label}: {s['calls']}x {avg:.0f}s avg, ~{avg_t:.0f} ptok"
                       + (f" ({s['slow']} slow)" if s["slow"] else ""))
        return "by-type — " + " | ".join(out) if out else "by-type — (none)"

def _gate_for(endpoint):
    """One concurrency gate per BOX (keyed by url). A box used as both actor and
    self-critic shares a single gate, so its total in-flight load stays bounded.
    Honors an optional per-endpoint `concurrency`, else the global MAX_CONCURRENCY."""
    url = endpoint["url"]
    with _gates_lock:
        if url not in _gates:
            n = int(endpoint.get("concurrency", MAX_CONCURRENCY))
            _gates[url] = {"sem": threading.Semaphore(max(1, n))}
        return _gates[url]

def _strip_think(text):
    """Qwen3.6 is a REASONING model: it emits a <think>...</think> trace before the
    real answer. If thinking isn't disabled server-side, that trace eats the token
    budget and pollutes JSON parsing. Strip any think block defensively so callers
    always get the actual answer, whether or not the flag took effect."""
    if not text:
        return text
    # remove a leading/complete think block
    import re as _re2
    text = _re2.sub(r"<think>.*?</think>", "", text, flags=_re2.S)
    # if a think block opened but never closed (truncated by max_tokens), drop it
    if "<think>" in text and "</think>" not in text:
        text = text.split("<think>")[0]
    return text.strip()


def _chat(endpoint, messages, temperature=0.6, max_tokens=2048, think=None, label="call"):
    url = endpoint["url"]
    gate = _gate_for(endpoint)
    # Resolve whether to reason on THIS call: explicit `think` arg wins; else fall
    # back to the endpoint default. Reasoning is powerful but SLOW (it generates a
    # long trace before answering), so we enable it selectively — on for strategic
    # decisions, off for mechanical code-gen — rather than globally.
    do_think = endpoint.get("no_think", False) is False if think is None else think
    # A reasoning call is EXPECTED to be slow; a mechanical one is not. Pick the
    # threshold accordingly so alerts mean something.
    slow_threshold = SLOW_REASON_S if do_think else SLOW_MECH_S
    # Prompt-size estimate is constant across retries (messages don't change), so
    # compute it once here and record it per label on success.
    ptoks = _est_prompt_tokens(messages)
    with gate["sem"]:
        last_err = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            t0 = time.time()
            try:
                body = {"model": endpoint["model"], "messages": messages,
                        "temperature": temperature, "max_tokens": max_tokens,
                        "stream": False}
                # Reasoning is expensive: only enable it when this call wants it.
                # When OFF, tell the template not to think (fast, short output) — both
                # llama.cpp and vLLM honor chat_template_kwargs.enable_thinking. When
                # ON, cap the trace length via reasoning_budget so a strategy call
                # reasons but doesn't ramble for 70s+ — BUT reasoning_budget is a
                # llama.cpp field; vLLM does not accept it and can 400 on the request,
                # so we only send it to llama.cpp boxes. On vLLM the trace is bounded
                # by max_tokens instead (set generously by actor() for think=True).
                # Thinking controls are Qwen3-only template features. Send them ONLY to
                # REASONING endpoints (reasoning defaults True, so Qwen3/Gemma behavior
                # is unchanged); a non-reasoning coder box (reasoning:False) gets neither
                # enable_thinking nor reasoning_budget, since its template lacks those
                # keys (unknown-field 400s on some servers).
                if endpoint.get("reasoning", True):
                    if not do_think:
                        body["chat_template_kwargs"] = {"enable_thinking": False}
                    elif endpoint.get("server", "llamacpp") == "llamacpp":
                        body["reasoning_budget"] = REASONING_BUDGET
                r = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {endpoint['key']}",
                             "Content-Type": "application/json"},
                    json=body,
                    timeout=TIMEOUT,
                )
                r.raise_for_status()
                dt = time.time() - t0
                _bump(url, calls=1, total_s=dt)
                is_slow = dt > slow_threshold
                _bump_label(label, dt, is_slow, ptoks)
                if is_slow:
                    _bump(url, slow=1)
                    kind = "reasoning" if do_think else "mechanical"
                    _emit(f"SLOW {kind} call [{label}] to {url.split('//')[-1].split(':')[0]} "
                          f"took {dt:.0f}s (threshold {slow_threshold:.0f}s"
                          + ("" if do_think else " — code-gen should be fast; "
                             "concurrency/GPU pressure? lower MAX_CONCURRENCY or add a box")
                          + ")")
                # Empty-completion handling. `finish=length` + empty `content` means the
                # model generated a full max_tokens but none of it landed in `content` —
                # the tell-tale sign the output went into a separate `reasoning_content`
                # field (llama.cpp routes a <think> trace there). If the real answer is
                # stuck in reasoning_content, salvage it (extract_code/json will pull the
                # block out) rather than returning nothing.
                _ch0 = r.json()["choices"][0]
                _msg = _ch0.get("message") or {}
                _content = _msg.get("content") or ""
                _reasoning = _msg.get("reasoning_content") or ""
                _finish = _ch0.get("finish_reason")
                _box = url.split("//")[-1].split(":")[0]
                _ans = _strip_think(_content)
                if not _ans and _reasoning:
                    _emit(f"CONTENT EMPTY — salvaging reasoning_content [{label}] to {_box} "
                          f"({len(_reasoning)} chars, finish={_finish}). The coder is "
                          f"emitting a <think> trace; start its llama-server with "
                          f"--reasoning-format none so output stays in content.")
                    _ans = _strip_think(_reasoning)
                elif not _ans:
                    _emit(f"EMPTY COMPLETION [{label}] to {_box}: no content or "
                          f"reasoning_content (finish={_finish}, max_tokens={max_tokens}, "
                          f"msg keys={list(_msg.keys())}).")
                return _ans
            except requests.Timeout as e:
                last_err = e
                _bump(url, timeouts=1)
                _emit(f"TIMEOUT ({TIMEOUT}s) to {url.split('//')[-1].split(':')[0]} "
                      f"attempt {attempt}/{MAX_ATTEMPTS}")
            except (requests.RequestException, KeyError, ValueError) as e:
                last_err = e
                # A 4xx carries the server's REASON in the response body (e.g. vLLM's
                # "maximum context length is 4096 tokens, however you requested 4398").
                # Without this, every prompt-too-long bug looks like a generic
                # "400 Bad Request" and is undiagnosable. Surface it.
                detail = ""
                resp = getattr(e, "response", None)
                if resp is not None:
                    try:
                        detail = f" | server said: {resp.text[:300]}"
                    except Exception:
                        pass
                # Retrying a 4xx is pointless — the request itself is malformed/too
                # long, and it will be rejected identically every time. Fail fast
                # instead of burning 3 attempts + backoff on a deterministic reject.
                if resp is not None and 400 <= resp.status_code < 500:
                    _emit(f"HTTP {resp.status_code} from "
                          f"{url.split('//')[-1].split(':')[0]} [{label}] — not "
                          f"retrying (request is malformed/too long){detail}")
                    _bump(url, failures=1)
                    raise RuntimeError(
                        f"LLM call to {url} rejected with "
                        f"{resp.status_code}{detail}") from e
                _emit(f"error to {url.split('//')[-1].split(':')[0]} "
                      f"attempt {attempt}/{MAX_ATTEMPTS}: {type(e).__name__}: "
                      f"{str(e)[:120]}{detail}")
            # if we got here, the attempt failed
            if attempt < MAX_ATTEMPTS:
                _bump(url, retries=1)
                time.sleep(RETRY_BACKOFF * attempt)
        _bump(url, failures=1)
        _emit(f"GAVE UP on {url.split('//')[-1].split(':')[0]} after "
              f"{MAX_ATTEMPTS} attempts: {last_err}")
        raise RuntimeError(f"LLM call to {url} failed after "
                           f"{MAX_ATTEMPTS} attempts: {last_err}")

# --- thinking policy ---------------------------------------------------------
# The set of request LABELS for which the actor reasons (think=True). Kept EMPTY of any
# CURRENTLY-FIRING label on purpose: on the DGX 122B-A10B (~20 t/s effective), a thinking
# call runs to the 6000-token cap = ~220-280s, which blew past the 300s TIMEOUT and then
# retried — a multi-minute stall per strategy call. So strategy/design run WITHOUT a
# think trace (still far smarter than the old model, and ~15-40s). The listed labels are
# FUTURE society calls that don't fire yet; they're pre-wired to reason once that layer
# exists AND only if it's on a box/budget where a long trace is affordable. Do NOT add
# strategy/design here unless the strategist box is fast enough to think in a few tens of
# seconds, or you bound the trace (a small max_tokens for the thinking call).
THINKING_LABELS = {"governance", "policy", "dispute", "trade"}

def should_think(label):
    """True if this request label should use reasoning. Central switch so enabling
    deep thinking for a new kind of decision is a one-line change (add its label)."""
    return label in THINKING_LABELS


# --- answer-length caps by label --------------------------------------------
# GENERATION, not prefill, is the real latency driver under concurrency: prefill of
# even a 6k-token prompt is ~10s at ~600 tok/s, but generating tokens at a CONTENDED
# ~30 tok/s (4 bots batched on one box) is ~33ms each — so a runaway 2048-token answer
# is ~60s. The old blanket max_tokens=2048 let a misbehaving code-gen ramble 5× past
# the contract (a task body is meant to be <25 lines / ~1500 chars ≈ 400 tokens),
# producing the 5k-char prose-in-code outputs that syntax-error anyway. Capping per
# label cuts the SLOW tail without truncating legitimate output:
#   code-gen/revise-code: a body is contractually tiny; 1024 is generous headroom yet
#     halves a 2048-token ramble.
#   strategy: a small JSON verdict object (~400 tok) — 1024 is plenty.
#   design: a full {x,y,z} cell list can be large (up to ~120 cells) — keep 2048.
#   naming/lesson: one short JSON line — 512.
# Callers can still override with an explicit max_tokens=. Unknown labels keep 2048.
MAX_TOKENS_BY_LABEL = {
    # 1024 was too tight for THIS model: it writes verbose bodies (hand-rolled loops
    # + prose) that ran ~900-950 code tokens plus preamble, so the cap guillotined the
    # code mid-statement -> "Unexpected end of input" syntax errors -> a wasted ~45s
    # generation AND a retry. 1536 fits the verbose-but-valid outputs while still
    # capping a true runaway. A truncation-retry is pure waste, so this REDUCES work.
    "code-gen": 1536, "revise-code": 1536,
    "strategy": 1024, "strategy-retry": 1024,
    "design": 2048,
    "naming": 512, "lesson": 512,
}


def actor(messages, think=None, label=None, **kw):
    # THINKING POLICY. Reasoning (`think=True`) roughly QUADRUPLES latency on the
    # vLLM boxes (a strategy call averages ~160s vs ~35s for a fast call), so it is
    # NOT worth it for mechanical work like "place these blocks" or "mine stone".
    # Reserve it for genuinely deliberative requests. Which requests those are is
    # decided by their LABEL: a label listed in THINKING_LABELS reasons; everything
    # else runs fast. Callers can still force it with think=True/False explicitly.
    #
    # Right now the set is EMPTY on purpose — nothing the society does today
    # (propose/code/critic) benefits enough to pay the latency. The framework is
    # here so that when large-scale civilization decisions arrive (governance,
    # policy, taxation, disputes, trade agreements — the "societal" layer in
    # GOVERNANCE_PLAN.md), you enable deep thinking for JUST those by adding their
    # labels below and tagging those calls with `label="governance"` etc.
    #   e.g.  THINKING_LABELS = {"governance", "policy", "taxes", "dispute"}
    lbl = label or "code"
    if think is None:
        think = should_think(lbl)
    if think:
        kw.setdefault("max_tokens", 6000)   # room for reasoning trace + answer
    else:
        # Answer only, no long trace. Cap per label so a runaway generation can't
        # burn ~60s rambling to 2048 tokens (the dominant SLOW-call cause).
        kw.setdefault("max_tokens", MAX_TOKENS_BY_LABEL.get(lbl, 2048))
    # Route by label: reasoning labels -> the shared STRATEGIST (big DGX mind),
    # everything else -> the fast per-thread coder actor (V100 hands).
    return _chat(_actor_ep_for(lbl), messages, think=think, label=lbl, **kw)

def critic(messages, **kw):
    # The critic returns ONE small JSON object: {"success":bool,"confidence":float,
    # "reason":"..."} — roughly 60-100 tokens. It was inheriting _chat's default
    # max_tokens=2048, which reserves 2048 tokens of the model's context window for
    # an answer that never uses them. On a small-context critic (Gemma served with
    # e.g. --max-model-len 4096) that reservation, ON TOP of a ~2.3k-token prompt,
    # pushes the request past the window and the server rejects the whole call with
    # 400 Bad Request. 256 is ample for the verdict and buys back ~1.8k tokens of
    # headroom for the before/after evidence.
    #
    # Routes to the CURRENT thread's bound critic box. On the new vLLM/qwen boxes
    # (which self-critique) the endpoint's `critic_think` is False, so thinking is
    # turned OFF for the verdict — a reasoning model would otherwise spend the whole
    # 256-token budget on a <think> trace and never emit the JSON. Gemma has no
    # `critic_think` field, so its behavior is exactly as before.
    # 256 was truncating the verdict: the critic often writes a sentence or two of
    # evidence BEFORE the JSON, and at 256 tokens the closing brace got cut off, so
    # the parser saw an unterminated object and failed ("no JSON found"), collapsing
    # to a false negative. 512 leaves room for the preamble + a complete object and
    # still fits a small-context critic (prompt ~2.3k + 512 < 4096). The critic
    # prompt also now asks it to emit the JSON FIRST, which makes truncation moot.
    kw.setdefault("max_tokens", 512)
    ep = _critic_ep()
    return _chat(ep, messages, temperature=0.2,
                 think=ep.get("critic_think", None), **kw)

def extract_code(text):
    # 1) A properly CLOSED fenced block is the happy path.
    m = re.search(r"```(?:javascript|js)?\s*(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # 2) An UNCLOSED fence means the generation was truncated at max_tokens mid-block
    #    (or the model forgot the closer). Take everything AFTER the opening fence to
    #    the end — running the model's actual code, not the PROSE preamble + a stray
    #    ``` marker (which is itself a syntax error). The body may still be incomplete,
    #    but this at least stops a leading explanation from being executed as code.
    m = re.search(r"```(?:javascript|js)?\s*(.*)$", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # 3) No fence at all — return as-is.
    return text.strip()

def extract_json(text):
    # 1) fenced ```json { ... } ``` block (preferred)
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = m.group(1) if m else None
    # 2) otherwise, first brace-balanced object anywhere in the text. Gemma often
    #    wraps the JSON in prose or a bulleted preamble ("* Task: ...") — scan for
    #    the first '{' and match to its balanced close, ignoring braces in strings.
    if candidate is None:
        start = text.find("{")
        if start >= 0:
            depth = 0; in_str = False; esc = False
            for i in range(start, len(text)):
                c = text[i]
                if in_str:
                    if esc: esc = False
                    elif c == "\\": esc = True
                    elif c == '"': in_str = False
                    continue
                if c == '"': in_str = True
                elif c == "{": depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start:i + 1]; break
    if candidate is None:
        raise ValueError(f"no JSON found in: {text[:200]}")
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # tolerate trailing commas and stray code fences that slipped in
        cleaned = re.sub(r",\s*([}\]])", r"\1", candidate).replace("```", "").strip()
        return json.loads(cleaned)
