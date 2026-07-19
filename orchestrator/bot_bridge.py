"""bot_bridge.py — manage the long-lived Node bot host over stdio JSON RPC."""
import json
import os
import queue
import subprocess
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_JS = os.path.join(ROOT, "node_host", "bot_host.js")

class BotBridge:
    def __init__(self, mc_host="localhost", mc_port=25565, username="SidBot",
                 auth="offline", version=None, on_log=None):
        env = dict(os.environ)
        env.update({"MC_HOST": mc_host, "MC_PORT": str(mc_port),
                    "MC_USERNAME": username, "MC_AUTH": auth})
        if version: env["MC_VERSION"] = str(version)
        self.proc = subprocess.Popen(
            ["node", HOST_JS], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
        self._id = 0
        self._pending = {}
        self._ready = threading.Event()
        self._on_log = on_log or (lambda t: None)
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._stderr_reader, daemon=True).start()

    def _stderr_reader(self):
        for line in self.proc.stderr:
            self._on_log(f"[node stderr] {line.rstrip()}")

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line: continue
            try: msg = json.loads(line)
            except json.JSONDecodeError:
                self._on_log(f"[node non-json] {line}"); continue
            t = msg.get("type")
            if t == "ready":
                self._ready.set(); self._on_log("[node] bot ready")
            elif t == "log":
                self._on_log(f"[bot] {msg.get('text')}")
            elif "id" in msg:
                q = self._pending.get(msg["id"])
                if q: q.put(msg)

    def wait_ready(self, timeout=120):
        if not self._ready.wait(timeout):
            raise TimeoutError("bot never spawned; check server/host/port/version")

    def _rpc(self, cmd, timeout=120, **kw):
        with self._lock:
            self._id += 1; mid = self._id
        q = queue.Queue(); self._pending[mid] = q
        self.proc.stdin.write(json.dumps({"id": mid, "cmd": cmd, **kw}) + "\n")
        self.proc.stdin.flush()
        try: return q.get(timeout=timeout)
        finally: self._pending.pop(mid, None)

    def get_state(self):
        return self._rpc("get_state", timeout=30)["data"]

    def run_skill(self, code, timeout_ms=60000, context=None):
        return self._rpc("run_skill", timeout=(timeout_ms / 1000) + 30,
                         code=code, timeout_ms=timeout_ms,
                         context=context or {})["data"]

    def chat(self, text):
        return self._rpc("chat", timeout=15, text=text)["data"]

    def close(self):
        try: self.proc.terminate()
        except Exception: pass
