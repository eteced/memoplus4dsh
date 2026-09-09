#!/usr/bin/env python3
"""A/B probe: does extraction survive a benchmark-style memorize lifecycle?

Variant A (close-fast): ingest, wait_queue_drain, close immediately.
Variant B (linger):     ingest, wait_queue_drain, sleep 60, close.

Usage: probe_ingest_ab.py A|B
"""
import os, sys, time

repo = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, repo)
import run_benchmark as rb
from agent_memoplus_dsh import MemoplusDshAgent

variant = sys.argv[1]
dsh_home = os.path.join(repo, "dsh-home")

rb.wipe_memory_state(dsh_home)
text = ("Alice moved to Shanghai on 2026-08-15. She adopted a cat named Snowball last week. "
        "Bob works at Acme Corp as a data engineer since 2021. " + "Filler sentence about the weather and city life. " * 150)
print(f"variant {variant}: text {len(text)} chars")

with MemoplusDshAgent(os.path.dirname(repo), context_tag="abprobe", dsh_home=dsh_home) as agent:
    t0 = time.time()
    agent.memorize([text])
    print(f"memorize returned in {time.time()-t0:.1f}s")
    if variant == "B":
        time.sleep(60)
    # memorize() already waits for queue drain; close happens on __exit__.

graph = os.path.join(dsh_home, "memoplus4dsh", "memory-graph.jsonl")
n = sum(1 for _ in open(graph)) if os.path.exists(graph) else -1
print(f"graph events: {n}")
print("plugin files:", sorted(os.listdir(os.path.join(dsh_home, "memoplus4dsh"))))
