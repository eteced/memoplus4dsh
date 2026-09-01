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
import subprocess
import sys
import time

import tiktoken


class DriverError(RuntimeError):
    pass


class DshDriver:
    """One long-lived node driver process (one dsh runtime lifetime)."""

    def __init__(self, repo_root, node_bin="node"):
        self.repo_root = repo_root
        env = dict(os.environ)
        env["BENCH_DSH_HOME"] = os.path.join(repo_root, "benchmark", "dsh-home")
        env["BENCH_WORKSPACE"] = os.path.join(repo_root, "benchmark")
        self.proc = subprocess.Popen(
            [node_bin, os.path.join(repo_root, "benchmark", "dsh-bench-driver.mjs")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            bufsize=1,
        )
        self._next_id = 0

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
        deadline = time.time() + (timeout or 600)
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if line == "":
                raise DriverError(f"driver process exited (cmd={cmd})")
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue
            if resp.get("id") != req_id:
                continue
            if not resp.get("ok"):
                raise DriverError(resp.get("error", "unknown driver error"))
            return resp
        raise DriverError(f"driver call timed out (cmd={cmd})")

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
                 batch_chars=16000, dsh_home=None):
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
        self.driver = DshDriver(self.repo_root, self.node_bin)
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
        self.driver._call("ingest", session=session, text=text)

    def wait_queue_drain(self, timeout=1800, poll=3.0):
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
        """Answer one query in a fresh session; official output dict shape."""
        self._query_count += 1
        session = f"bench-q{self._query_count}-{self.context_tag}"
        start = time.time()
        resp = self.driver._call("ask", session=session, text=query)
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
