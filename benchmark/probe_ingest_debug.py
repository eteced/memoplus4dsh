#!/usr/bin/env python3
"""Minimal ingest probe: one turn, then watch extraction artifacts appear."""
import json, os, subprocess, sys, time

repo = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, repo)
from agent_memoplus_dsh import DshDriver

driver = DshDriver(repo_root=os.path.dirname(repo), dsh_home=os.path.join(repo, "dsh-home"))
try:
    t0 = time.time()
    r = driver.call("ingest", session="debug-ingest-1",
                    text="Alice moved to Shanghai on 2026-08-15. She adopted a cat named Snowball last week.\n\n（以上是需要记忆的材料，只需回复：已记录）",
                    timeout=120)
    print(f"ingest ok in {time.time()-t0:.1f}s: {r.get('ok')}")
    data = os.path.join(repo, "dsh-home", "memoplus4dsh")
    for i in range(40):
        time.sleep(3)
        files = sorted(os.listdir(data)) if os.path.isdir(data) else []
        print(f"[{i*3+3:3d}s] {files}", flush=True)
        if "memory-graph.jsonl" in files:
            with open(os.path.join(data, "memory-graph.jsonl")) as fh:
                lines = fh.readlines()
            print(f"GRAPH: {len(lines)} events")
            for ln in lines[:3]:
                print("  ", ln[:200])
            break
    else:
        print("TIMEOUT: no memory-graph.jsonl after 120s")
finally:
    driver.close()
