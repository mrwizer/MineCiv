"""skills.py — keyword-indexed skill library with success/failure tracking
and in-place revision.

Working skills live as .js in skills/working/. The manifest maps
name -> {description, keywords, file, uses, fails, revisions, retired, ...}.

Skills are no longer trusted forever: each use records success/failure. A skill
that starts failing gets REVISED in place (same name/keywords, new code) so
callers keep finding it but get the improved version — mirroring a human going
"the way I used to do this stopped working, let me fix my approach."
"""
import json
import os
import re
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKING = os.path.join(ROOT, "skills", "working")
ARCHIVE = os.path.join(ROOT, "skills", "archive")   # revisions go HERE, not WORKING
MANIFEST = os.path.join(ROOT, "skills", "skill_manifest.json")
os.makedirs(WORKING, exist_ok=True)
os.makedirs(ARCHIVE, exist_ok=True)

# ---- FREEZE: canonical behaviors the LLM must NOT keep regenerating -----------
# Maps a behavior key -> the one frozen skill slug that implements it. When the
# proposer's new-skill would fall into one of these behaviors, promote() refuses
# and the caller should reuse the frozen skill instead. This is the valve that
# stops the library ballooning to 200 variants of the same 19 behaviors.
# Populate the slugs with your chosen survivors after dedup.
FROZEN = {
    "collect_log":          "collect_and_handle_stuck_logs",
    "craft_wooden_pickaxe": "craft_wooden_pickaxe",
    "mine_cobblestone":     "mine_cobblestone",
    "craft_stone_pickaxe":  "craft_stone_pickaxe",
    "escape_navigate":      "escape_pocket_navigate",
    # add the rest of your 19 canonical slugs here as you lock them in
}
# regexes that map an arbitrary new skill name to a frozen behavior key
_BEHAVIOR_PATTERNS = [
    (r".*collect.*log.*|.*collect_wood.*|.*collect_one_log.*|.*collectanylog.*", "collect_log"),
    (r".*craft.*wooden.*pickaxe.*|.*craft_basic_tools.*",  "craft_wooden_pickaxe"),
    (r".*craft.*stone.*pickaxe.*",                         "craft_stone_pickaxe"),
    (r".*mine.*cobble.*|.*acquire_cobble.*",               "mine_cobblestone"),
    (r".*escape.*|.*return_to_surface.*|.*navigate_to_village.*", "escape_navigate"),
]

def _behavior_of(name):
    n = (name or "").lower()
    for pat, key in _BEHAVIOR_PATTERNS:
        if re.fullmatch(pat, n):
            return key
    return None

_lock = threading.RLock()   # shared library: multiple bot threads touch it

def _load():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f: return json.load(f)
    return {}

def _save(m):
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f: json.dump(m, f, indent=2)
    os.replace(tmp, MANIFEST)   # atomic

def list_skills():
    with _lock:
        return _load()

def manifest_summary(limit=28):
    """Skills shown to the actor for reuse. Retired skills are hidden, and each
    line shows a reliability hint so the model prefers proven skills.

    CAPPED: the full list is injected into every strategy/code prompt, so an
    unbounded library silently inflates prompt size and blows up reasoning latency
    (observed strategy calls climbing 88s -> 218s as the library grew mid-run).
    Show canonical/frozen skills first, then the most-reliable others, up to `limit`.
    """
    with _lock:
        m = _load()
    live = {n: v for n, v in m.items() if not v.get("retired")}
    if not live: return "(no working skills yet)"
    def rank(item):
        n, v = item
        canonical = v.get("canonical") or v.get("frozen")
        uses, fails = v.get("uses", 0), v.get("fails", 0)
        rel = uses - fails
        return (0 if canonical else 1, -rel, n)   # canonical first, then net-reliable
    ordered = sorted(live.items(), key=rank)[:limit]
    lines = []
    for n, v in sorted(ordered, key=lambda kv: kv[0]):
        uses, fails = v.get("uses", 0), v.get("fails", 0)
        rel = f"{uses} ok/{fails} fail" if (uses + fails) else "untried"
        lines.append(f"- {n}: {v['description']} [{rel}; keywords: {', '.join(v['keywords'])}]")
    extra = len(live) - len(ordered)
    if extra > 0:
        lines.append(f"- (+{extra} more skills available via retrieval)")
    return "\n".join(lines)

def get_code(name):
    with _lock:
        m = _load()
        if name not in m: return None
        with open(os.path.join(WORKING, m[name]["file"])) as f: return f.read()

def _slug(name):
    s = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    return s or f"skill_{int(time.time())}"

# ---- behavior signature: world-agnostic identity of WHAT a skill DOES -----------
# The library ballooned to 400+ files because the same behavior gets many names
# ("craft_sticks", "craft_sticks_from_oak", "craft_sticks_1783550327"), and promote()
# only deduped against a 5-entry FROZEN whitelist. A behavior SIGNATURE fixes this
# generally: it reduces a skill NAME to the set of meaningful action/object tokens,
# so all those names collapse to one identity and later bots REUSE the existing skill.
#
# Crucially this is derived ONLY from the name (which describes behavior), NEVER from
# coordinates or any world state — so the same behavior has the same signature in ANY
# world and across restarts. Knowledge is learned once and shared, like a real society.
_SIG_STOP = {
    # grammar / filler
    "from", "to", "the", "a", "an", "and", "with", "then", "for", "of", "using", "use",
    "more", "some", "extra", "additional", "new", "initial", "basic", "simple",
    "temp", "temporary", "my", "our", "it", "is",
    # LOCATION / world-relative qualifiers — these are exactly the world-specific bits
    # we must ignore so a skill is the same behavior anywhere it's performed.
    "near", "nearby", "at", "in", "on", "here", "there", "around", "area", "surface",
    "spot", "site", "up", "down", "north", "south", "east", "west", "left", "right",
    "water", "workshop", "home", "base", "village", "chest", "storage",
}
# Wood SPECIES are cosmetic variants of the same behavior (craft oak vs birch planks
# is one skill). Tool TIERS (wooden/stone/iron/...) are NOT here — they're genuinely
# different skills (different recipes), so they stay in the signature.
_SIG_SPECIES = {"oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "dark",
                "cherry", "mangrove", "bamboo", "pale", "crimson", "warped"}

def _stem(tok):
    # crude singularize so sticks==stick, planks==plank, seeds==seed, logs==log,
    # torches==torch. Behavior identity shouldn't hinge on plural vs singular.
    if len(tok) > 3 and tok.endswith("es") and tok[-3] in "sxzh":
        return tok[:-2]
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok

def _behavior_sig(name):
    """A frozenset of stemmed action/object tokens identifying the behavior. Name-only
    and world-agnostic, so identical behaviors share a signature in any world."""
    toks = [t for t in re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).split() if t]
    keep = []
    for t in toks:
        if t.isdigit():                       # timestamps / counts — never identity
            continue
        if t in _SIG_STOP or t in _SIG_SPECIES:
            continue
        keep.append(_stem(t))
    sig = frozenset(keep)
    # If stripping removed everything (e.g. a name made only of qualifiers), fall back
    # to the raw tokens so we never collapse unrelated skills to an empty signature.
    return sig if sig else frozenset(_stem(t) for t in toks if not t.isdigit())

def _sig_of_meta(slug, meta):
    """Signature for an existing manifest entry — cached in 'sig', else derived from
    its slug so pre-existing skills (no stored sig) still dedup correctly."""
    stored = meta.get("sig")
    return frozenset(stored) if stored is not None else _behavior_sig(slug)

def retrieve(task_text, top_k=5):
    with _lock:
        m = _load()
    if not m: return []
    words = set(re.findall(r"[a-z]+", task_text.lower()))
    scored = []
    for name, meta in m.items():
        if meta.get("retired"): continue
        kw = set(k.lower() for k in meta["keywords"]) | set(re.findall(r"[a-z]+", name.lower()))
        overlap = len(words & kw)
        if overlap:
            # prefer skills with a good track record
            reliability = meta.get("uses", 0) - meta.get("fails", 0)
            scored.append((overlap, reliability, name))
    scored.sort(reverse=True)
    return [n for _, _, n in scored[:top_k]]

def promote(name, description, keywords, code):
    """Add a newly-learned skill to the shared library, OR reuse an existing skill
    that already implements the same behavior. Returns (slug, created) where created
    is False if an existing skill was reused. This is the valve that keeps the library
    to one skill per behavior — learned once, shared by every bot, in any world."""
    with _lock:
        m = _load()
        # FREEZE GATE (hard override): explicit canonical behaviors always win.
        beh = _behavior_of(name)
        if beh and beh in FROZEN:
            canonical = FROZEN[beh]
            if canonical in m:
                return canonical, False   # caller reuses the frozen one; no new file
        # GENERAL DEDUP: if a non-retired skill with the same behavior signature
        # already exists, REUSE it (accumulating its shared use/fail record) rather
        # than writing another near-identical file. Prefer the most reliable variant
        # when the messy existing library has several of the same behavior.
        sig = _behavior_sig(name)
        best, best_rel = None, None
        for s, meta in m.items():
            if meta.get("retired"):
                continue
            if _sig_of_meta(s, meta) == sig:
                rel = meta.get("uses", 0) - meta.get("fails", 0)
                if best is None or rel > best_rel:
                    best, best_rel = s, rel
        if best is not None:
            return best, False            # reuse existing skill for this behavior
        # genuinely new behavior → create it, caching its signature for fast future dedup
        slug = _slug(name)
        if slug in m:
            slug = f"{slug}_{int(time.time())}"
        fname = f"{slug}.js"
        with open(os.path.join(WORKING, fname), "w") as f:
            f.write(code)
        m[slug] = {"description": description, "keywords": keywords, "file": fname,
                   "uses": 0, "fails": 0, "revisions": 0, "retired": False,
                   "sig": sorted(sig),
                   "created": time.strftime("%Y-%m-%d %H:%M:%S")}
        _save(m)
        return slug, True

def record_use(name, success):
    """Log the outcome of using a skill. Returns the skill's current health dict."""
    with _lock:
        m = _load()
        if name not in m: return None
        if success:
            m[name]["uses"] = m[name].get("uses", 0) + 1
        else:
            m[name]["fails"] = m[name].get("fails", 0) + 1
        _save(m)
        return dict(m[name])

def is_proven(name, min_uses=3):
    """True if a saved skill has a solid track record: enough successful uses AND
    clearly more successes than failures. Used to skip the (slow) LLM critic when a
    TRUSTED skill is reused — a fast programmatic pass/fail is enough there, and the
    LLM critic's real job (gating promotion of NEW skills) doesn't apply to a skill
    that's already proven. Young or shaky skills still get the full LLM verdict."""
    with _lock:
        m = _load()
    e = m.get(name)
    if not e or e.get("retired"):
        return False
    uses, fails = e.get("uses", 0), e.get("fails", 0)
    return uses >= min_uses and uses > fails

# kept for backward-compat with earlier callers
def bump_use(name):
    return record_use(name, True)

def needs_revision(name, min_fails=5):
    """A skill is worth revising only if it has failed a LOT and is genuinely
    unreliable. The bar is deliberately high: rewriting a skill on 2 failures was
    destroying working skills whose failures were world-caused or critic
    false-negatives (see log analysis — the same skill re-spawned 10+ variants).
    A skill must now fail >= min_fails times (default 5) AND fail clearly more
    often than it succeeds before we touch its code. Frozen/canonical skills are
    never revised regardless (see revise())."""
    with _lock:
        m = _load()
        if name not in m: return False
        v = m[name]
        if v.get("frozen") or v.get("canonical"):
            return False
        fails = v.get("fails", 0)
        uses = v.get("uses", 0)
        if fails < min_fails: return False
        # genuinely unreliable: fails clearly outnumber successes (not just >=).
        return fails > uses + 1

def revise(name, new_code, note=""):
    """Overwrite a skill's code in place, keeping its name/keywords so callers
    still find it. Resets the fail counter (giving the new version a clean slate)
    and archives the old code for debugging."""
    with _lock:
        m = _load()
        if name not in m: return False
        # FREEZE GATE: never rewrite a frozen canonical skill via the LLM revision
        # path. If a frozen skill is failing it's a helper/world issue to fix by
        # hand, not something to regenerate into a new broken variant.
        if name in FROZEN.values():
            return False
        path = os.path.join(WORKING, m[name]["file"])
        # archive prior version INTO THE ARCHIVE DIR (not WORKING, which the
        # manifest/retrieval scans — writing archives there is what ballooned the
        # library to 200 files).
        try:
            old = open(path).read()
            arch = os.path.join(ARCHIVE, f"_archive_{name}_v{m[name].get('revisions',0)}.js")
            with open(arch, "w") as f: f.write(old)
        except OSError:
            pass
        with open(path, "w") as f: f.write(new_code)
        m[name]["revisions"] = m[name].get("revisions", 0) + 1
        m[name]["fails"] = 0                       # clean slate for the new version
        m[name]["last_revised"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if note: m[name]["revision_note"] = note[:200]
        _save(m)
        return True

def retire(name):
    """Hide a skill that couldn't be revised into something working, so it stops
    being suggested. Kept on disk for inspection."""
    with _lock:
        m = _load()
        if name in m:
            m[name]["retired"] = True
            _save(m)
