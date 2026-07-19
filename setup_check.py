#!/usr/bin/env python3
"""setup_check.py — verify the environment before running. python3 setup_check.py"""
import os, shutil, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "orchestrator"))
OK, BAD = "\u2705", "\u274c"

def check_python():
    try:
        import requests  # noqa
        print(f"{OK} python 'requests' installed"); return True
    except ImportError:
        print(f"{BAD} missing 'requests' -> pip install requests"); return False

def check_node():
    if not shutil.which("node"):
        print(f"{BAD} node not found -> install Node.js >= 22"); return False
    v = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    major = int(v.lstrip("v").split(".")[0]); ok = major >= 22
    print(f"{OK if ok else BAD} node {v} ({'>=22' if ok else 'NEED >=22'})")
    nm = os.path.join(os.path.dirname(__file__), "node_host", "node_modules", "mineflayer")
    if os.path.isdir(nm): print(f"{OK} node_modules present (mineflayer installed)")
    else: print(f"{BAD} node deps missing -> cd node_host && npm install"); ok = False
    return ok

def check_endpoints():
    """Ping EVERY registered endpoint (both original boxes + the four new vLLM
    boxes), deduped by URL, and report which config.BOTS each one serves — so a
    misconfigured or unreachable group is obvious before a 20-bot run starts."""
    import llm, config
    # which bots are bound to each endpoint id, for a readable report
    serves = {}
    for b in getattr(config, "BOTS", []):
        serves.setdefault(b.get("actor_endpoint", "actor"), set()).add(b["username"])
        serves.setdefault(b.get("critic_endpoint", "critic"), set()).add(b["username"])
    # dedupe by url so a box used as both actor+critic is pinged once
    seen_urls, all_ok = set(), True
    for eid, ep in llm.ENDPOINTS.items():
        if ep["url"] in seen_urls:
            continue
        seen_urls.add(ep["url"])
        who = ", ".join(sorted(serves.get(eid, []))) or "(no bots bound)"
        try:
            reply = llm._chat(ep, [{"role": "user", "content": "Reply with just: OK"}],
                              max_tokens=10)
            print(f"{OK} {eid} [{ep['model']} @ {ep['url'].split('//')[-1].split('/')[0]}] "
                  f"reachable -> {reply.strip()[:30]!r}  serves: {who}")
        except Exception as e:
            print(f"{BAD} {eid} [{ep['url']}] FAILED: {e}"); all_ok = False
    return all_ok

if __name__ == "__main__":
    print("== mc-sid setup check ==")
    results = [check_python(), check_node(), check_endpoints()]
    print("\nAll good — run: cd orchestrator && python3 runner.py" if all(results)
          else "\nFix the \u274c items above first.")
