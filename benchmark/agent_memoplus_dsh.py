"""
MemoplusDshAgent — drives one dsh runtime (sdk profile + memoplus4dsh plugin)
through the stdio JSON-lines driver (benchmark/dsh-bench-driver.mjs).

Protocol compliance with the official MemoryAgentBench harness:
- memorize(chunks): batched ingest; the plugin extracts memories at turn/end.
- ask(query): one FRESH dsh session per query (memory shared via the graph,
  matching the stateless-query protocol of the official RAG agents).
- ask() returns the official output dict shape; input_len/output_len are
  tiktoken counts (documented approximation — only affects system metrics,
  never correctness scores).
"""

import json
import os
import select
import subprocess
import sys
import time

import tiktoken


class DriverError(RuntimeError):
    pass


class DshDriver:
    """One long-lived node driver process (one dsh runtime lifetime)."""

    def __init__(self, repo_root, dsh_home, node_bin="node"):
        self.repo_root = repo_root
        self.dsh_home = dsh_home
        self.node_bin = node_bin
        self.proc = None
        self._next_id = 0
        self.start()

    def start(self):
        env = dict(os.environ)
        env["BENCH_DSH_HOME"] = self.dsh_home
        env["BENCH_WORKSPACE"] = os.path.join(self.repo_root, "benchmark")
        self.proc = subprocess.Popen(
            [self.node_bin, os.path.join(self.repo_root, "benchmark", "dsh-bench-driver.mjs")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            bufsize=1,
        )

    def restart(self):
        """Kill the runtime (and its hung turn) and boot a fresh one.

        Memory lives in the on-disk graph, so a restart loses nothing but the
        pathological in-flight turn itself. process_group is EPERM in this
        environment, so the dsh child is cleaned up by binary name (only one
        bench runtime exists at a time).
        """
        try:
            self.proc.kill()
        except (ProcessLookupError, PermissionError):
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        subprocess.run(["pkill", "-f", "dsh-install/node_modules/.bin/dsh"],
                       check=False, capture_output=True)
        self.start()

    def _call(self, cmd, session=None, text=None, timeout=None):
        self._next_id += 1
        req_id = self._next_id
        payload = {"id": req_id, "cmd": cmd}
        if session is not None:
            payload["session"] = session
        if text is not None:
            payload["text"] = text
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        # select-based read: a bare readline() blocks forever and would
        # silently defeat the deadline (observed: a 330-step pathological
        # query hung the runner for 75+ minutes despite a 600s "timeout").
        fd = self.proc.stdout.fileno()
        deadline = time.time() + (timeout or 600)
        buf = ""
        while time.time() < deadline:
            remaining = deadline - time.time()
            ready, _, _ = select.select([fd], [], [], min(5.0, max(0.1, remaining)))
            if not ready:
                continue
            chunk = os.read(fd, 65536)
            if not chunk:
                raise DriverError(f"driver process exited (cmd={cmd})")
            buf += chunk.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                try:
                    resp = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if resp.get("id") != req_id:
                    continue
                if not resp.get("ok"):
                    raise DriverError(resp.get("error", "unknown driver error"))
                return resp
        raise DriverError(f"driver call timed out after {timeout or 600}s (cmd={cmd})")

    def call(self, cmd, session=None, text=None, timeout=None):
        """_call with one driver-restart retry on transient runtime boot exits."""
        try:
            return self._call(cmd, session=session, text=text, timeout=timeout)
        except DriverError as error:
            if "runtime exited" not in str(error):
                raise
            print(f"[driver] runtime exited during {cmd}; restarting driver once")
            self.restart()
            return self._call(cmd, session=session, text=text, timeout=timeout)

    def close(self):
        try:
            self._call("close", timeout=120)
        except DriverError:
            pass
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()


class MemoplusDshAgent:
    """The benchmarked combination: dsh + memoplus4dsh with default config."""

    def __init__(self, repo_root, context_tag, node_bin="node",
                 batch_chars=8000, dsh_home=None):
        self.repo_root = repo_root
        self.context_tag = context_tag
        self.batch_chars = batch_chars
        self.dsh_home = dsh_home or os.path.join(repo_root, "benchmark", "dsh-home")
        self.plugin_data = os.path.join(self.dsh_home, "memoplus4dsh")
        self.node_bin = node_bin
        self.driver = None
        self.tokenizer = tiktoken.encoding_for_model("gpt-4o-mini")
        self._query_count = 0

    # ---------- lifecycle ----------

    def __enter__(self):
        self.driver = DshDriver(self.repo_root, self.dsh_home, self.node_bin)
        return self

    def __exit__(self, *_):
        if self.driver:
            self.driver.close()

    # ---------- memorize ----------

    def memorize(self, formatted_chunks):
        """Ingest pre-formatted chunks in batches; returns construction seconds."""
        start = time.time()
        batch, batch_len, batch_no = [], 0, 0
        for chunk in formatted_chunks:
            # +1 for the newline joiner
            if batch and batch_len + len(chunk) + 1 > self.batch_chars:
                self._send_batch(batch, batch_no)
                batch_no += 1
                batch, batch_len = [], 0
            batch.append(chunk)
            batch_len += len(chunk) + 1
        if batch:
            self._send_batch(batch, batch_no)
        self.wait_queue_drain()
        return time.time() - start

    def _send_batch(self, chunks, batch_no):
        text = "\n".join(chunks) + "\n\n（以上是需要记忆的材料，只需回复：已记录）"
        session = f"bench-ingest-{self.context_tag}-{batch_no}"
        self.driver.call("ingest", session=session, text=text)

    def wait_queue_drain(self, timeout=7200, poll=3.0):
        """Wait until the durable extraction queue has no unsettled jobs."""
        pending_file = os.path.join(self.plugin_data, "extraction-pending.jsonl")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._queue_settled(pending_file):
                # One extra beat for the in-flight snapshot write.
                time.sleep(2)
                return
            time.sleep(poll)
        raise DriverError("extraction queue did not drain in time")

    @staticmethod
    def _queue_settled(pending_file):
        if not os.path.exists(pending_file):
            return True
        pending, settled = set(), set()
        with open(pending_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("kind") == "pending":
                    job = entry.get("job", {})
                    pending.add(f"{job.get('sessionId')}:{job.get('turn')}")
                elif entry.get("kind") == "settled":
                    settled.add(f"{entry.get('sessionId')}:{entry.get('turn')}")
        return pending <= settled

    # ---------- query ----------

    def ask(self, query):
        """Answer one query in a fresh session; official output dict shape.

        A driver failure (e.g. the per-query timeout on a pathological
        agentic loop) is recorded as a wrong-but-present answer instead of
        crashing the whole run: the harness skips nothing, and one hung
        question must not hold the benchmark hostage.
        """
        self._query_count += 1
        session = f"bench-q{self._query_count}-{self.context_tag}"
        start = time.time()
        try:
            resp = self.driver.call("ask", session=session, text=query, timeout=int(os.environ.get("BENCH_ASK_TIMEOUT", "900")))
        except DriverError as error:
            query_time = time.time() - start
            print(f"\n[ask] query failed after {query_time:.0f}s ({error}); recorded as wrong answer")
            # The node driver is still awaiting the hung turn and would not
            # serve the next query: restart the runtime (memory is on disk).
            try:
                self.driver.restart()
            except Exception as restart_error:  # noqa: BLE001
                print(f"[ask] driver restart failed: {restart_error}")
            return {
                "output": "",
                "input_len": 0,
                "output_len": 0,
                "memory_construction_time": 0,
                "query_time_len": query_time,
                "injected": "",
            }
        query_time = time.time() - start
        output = resp.get("reply", "")
        injected = resp.get("injected", "")
        return {
            "output": output,
            "input_len": len(self.tokenizer.encode(injected + "\n" + query)),
            "output_len": len(self.tokenizer.encode(output)),
            "memory_construction_time": 0,
            "query_time_len": query_time,
            "injected": injected,  # debug aid; ignored by the metrics
        }
