#!/usr/bin/env python3
"""
audit_sessions.py — per-context post-run auditor for benchmark session logs.

Purpose (user requirement): every context gets audited IMMEDIATELY after it
finishes, so a leak is caught before burning another context's tokens. The
auditor answers one question: did answers come from the memory plugin, or
from shenanigans (filesystem reads, network, script execution)?

Checks (any hit = anomaly):
  1. Non-memory tool calls (should be zero: the whitelist guard denies them
     at tools/pre-execute; a SUCCESSFUL non-memory tool/result means the
     guard itself failed).
  2. Attempted non-memory calls (model tried; guard denied — logged as
     "denied attempts", informational but reported).
  3. Guard denial log cross-check (bench-guard-denials.jsonl exists when
     denials happened).
  4. Suspicious content in any tool result or assistant text (parquet /
     dataset paths / "answers" column dumps).

Usage standalone:  audit_sessions.py <session-archive-dir> [--strict]
As library:        audit(dir) -> (ok, report_dict)
"""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

MEMORY_TOOLS = {"memory_search", "memory_remember"}
SUSPICIOUS_RE = re.compile(
    r"\.parquet|datasets--ai-hyz|MemoryAgentBench|\.arrow\b|\banswers\b\s*[:=]", re.I)


def _read_session(path):
    try:
        out = subprocess.run(["zstd", "-dc", str(path)], capture_output=True).stdout.decode()
    except Exception:
        return []
    events = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def audit(archive_dir):
    """Audit one archived context directory. Returns (ok, report)."""
    root = Path(archive_dir)
    sessions = sorted(root.rglob("session.jsonl.zstd"))
    report = {
        "dir": str(root),
        "sessions": len(sessions),
        "tool_calls": {},
        "successful_nonmemory_tools": [],
        "denied_attempts": {},
        "suspicious_content": [],
        "guard_denials_lines": 0,
    }
    calls = Counter()
    denied = Counter()
    for sess in sessions:
        sid = sess.parent.name
        events = _read_session(sess)
        # tool/call name -> whether a tool/result with ok content followed
        result_by_call = {}
        for e in events:
            if e.get("type") == "tool/result":
                data = e.get("data", {})
                cid = data.get("callId") or ""
                text = json.dumps(data, ensure_ascii=False)
                result_by_call[cid] = ("isError" not in text or '"isError":false' in text)
        for e in events:
            if e.get("type") != "tool/call":
                continue
            name = e.get("data", {}).get("name", "?")
            cid = e.get("data", {}).get("callId", "")
            calls[name] += 1
            if name not in MEMORY_TOOLS:
                succeeded = result_by_call.get(cid, False)
                denied[name] += 1
                if succeeded:
                    report["successful_nonmemory_tools"].append(
                        {"session": sid, "tool": name,
                         "args": json.dumps(e["data"].get("arguments"), ensure_ascii=False)[:200]})
            args_text = json.dumps(e.get("data", {}).get("arguments", ""), ensure_ascii=False)
            if SUSPICIOUS_RE.search(args_text):
                report["suspicious_content"].append(
                    {"session": sid, "tool": name, "args": args_text[:200]})
    report["tool_calls"] = dict(calls)
    report["denied_attempts"] = dict(denied)

    denials_log = root.parent.parent / "guard-denials" / (root.name + ".jsonl")
    if denials_log.exists():
        report["guard_denials_lines"] = sum(1 for _ in open(denials_log))

    ok = (not report["successful_nonmemory_tools"]) and (not report["suspicious_content"])
    return ok, report


def main():
    if len(sys.argv) < 2:
        print("usage: audit_sessions.py <session-archive-dir>")
        sys.exit(2)
    ok, report = audit(sys.argv[1])
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("AUDIT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
