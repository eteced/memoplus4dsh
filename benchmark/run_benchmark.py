#!/usr/bin/env python3
"""
run_benchmark.py — MemoryAgentBench runner for the memoplus4dsh + dsh combo.

Reuses the official harness code verbatim for everything that determines
comparability:
- ConversationCreator (dataset loading + chunking)
- utils.templates.get_template (memorize/query formatting, rag_agent family)
- utils.eval_other_utils.metrics_summarization (metric computation)
- the output JSON structure of official main.py

Only the agent itself (MemoplusDshAgent) and this orchestration are ours.

Usage (from benchmark/):
  DEEPSEEK_API_KEY=... ./venv/bin/python run_benchmark.py \
      --dataset_config MemoryAgentBench/configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml \
      [--max_contexts 1] [--max_queries 0] [--force]
"""

import argparse
import json
import os
import shutil
import sys
import time
from collections import defaultdict

import numpy as np
import yaml
from tqdm import tqdm

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAB_DIR = os.path.join(REPO_ROOT, "benchmark", "MemoryAgentBench")
ORIG_CWD = os.getcwd()
sys.path.insert(0, MAB_DIR)
os.chdir(MAB_DIR)  # official modules resolve data/templates relatively

from conversation_creator import ConversationCreator  # noqa: E402
from utils.eval_other_utils import metrics_summarization  # noqa: E402
from utils.templates import get_template  # noqa: E402

sys.path.insert(0, os.path.join(REPO_ROOT, "benchmark"))
from agent_memoplus_dsh import MemoplusDshAgent  # noqa: E402

AGENT_NAME = "memoplus_dsh_rag"  # maps to the rag_agent template family


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset_config", required=True)
    parser.add_argument("--agent_config", default=None,
                        help="informational only; recorded into the results JSON")
    parser.add_argument("--max_contexts", type=int, default=0)
    parser.add_argument("--max_queries", type=int, default=0,
                        help="global query cap across contexts (0 = no limit)")
    parser.add_argument("--query_stride", type=int, default=1,
                        help="mini-split: ask only every Nth question per context "
                             "(ingest stays full; deterministic, fixed question set)")
    parser.add_argument("--query_offset", type=int, default=0,
                        help="mini-split: which residue class to ask (0..stride-1)")
    parser.add_argument("--run_tag", default=None,
                        help="explicit tag for the output filename (e.g. iteration round 'm11v2'); "
                             "keeps iteration results separate and resumable per round")
    parser.add_argument("--dsh_home", default=None,
                        help="benchmark dsh home (default benchmark/dsh-home); "
                             "use a second home for parallel runs")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def output_path_for(dataset_config):
    name_tag = "_".join([
        str(dataset_config.get("sub_dataset")),
        str(dataset_config.get("tag")),
        f"in{dataset_config.get('context_max_length')}",
        f"size{dataset_config.get('generation_max_length')}",
        f"shots{dataset_config.get('shots')}",
        f"max_samples{dataset_config.get('max_test_samples')}",
        "k8",
        f"chunk{dataset_config.get('chunk_size')}",
        "memoplus4dsh",
    ])
    out_dir = os.path.join(REPO_ROOT, "benchmark", "results", dataset_config["dataset"])
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"{name_tag}_results.json")


def save_results(path, agent_config, dataset_config, results, metrics, time_cost_list, start_time):
    averaged = {
        key: float(np.mean(values)) * (1 if ("_len" in key) or ("_time" in key) else 100)
        for key, values in metrics.items()
    }
    time_cost_list.append(time.time() - start_time)
    with open(path, "w") as fh:
        json.dump({
            "agent_config": agent_config,
            "dataset_config": dataset_config,
            "data": results,
            "metrics": {k: list(v) for k, v in metrics.items()},
            "time_cost": time_cost_list,
            "averaged_metrics": averaged,
        }, fh, indent=4, ensure_ascii=False)


def load_existing(path):
    """Resume support: (results, done_query_count) from a previous partial run."""
    if not os.path.exists(path):
        return [], 0
    with open(path) as fh:
        saved = json.load(fh)
    return saved.get("data", []), len(saved.get("data", []))


def wipe_memory_state(dsh_home):
    """Fresh memory per context == RAG agents rebuilding their store per context.

    Wipes the graph/journal/session state but PRESERVES the models dir
    (pre-warmed 135MB embedding download) and the profile.
    """
    sessions = os.path.join(dsh_home, "sessions")
    if os.path.exists(sessions):
        shutil.rmtree(sessions)
    plugin_data = os.path.join(dsh_home, "memoplus4dsh")
    if os.path.exists(plugin_data):
        for name in os.listdir(plugin_data):
            if name == "models":
                continue
            target = os.path.join(plugin_data, name)
            if os.path.isdir(target):
                shutil.rmtree(target)
            else:
                os.remove(target)


def archive_sessions(dsh_home, tag):
    """Move this context's session logs + guard denial log into
    results/sessions-archive/<tag>/ for the audit trail (user requirement:
    中间过程全留存). Also COPY the memory graph (m11: per-context graph
    enables extraction-vs-retrieval failure attribution later).
    Returns the archive dir."""
    archive_root = os.path.join(REPO_ROOT, "benchmark", "results", "sessions-archive", tag)
    sessions = os.path.join(dsh_home, "sessions")
    if os.path.exists(sessions):
        shutil.move(sessions, archive_root)
    else:
        os.makedirs(archive_root, exist_ok=True)
    graph = os.path.join(dsh_home, "memoplus4dsh", "memory-graph.jsonl")
    if os.path.exists(graph):
        shutil.copy(graph, os.path.join(archive_root, "memory-graph.jsonl"))
    denials = os.path.join(dsh_home, "bench-guard-denials.jsonl")
    if os.path.exists(denials):
        den_dir = os.path.join(REPO_ROOT, "benchmark", "results", "guard-denials")
        os.makedirs(den_dir, exist_ok=True)
        shutil.move(denials, os.path.join(den_dir, tag + ".jsonl"))
    return archive_root


def audit_context(dsh_home, tag):
    """Archive then audit; abort the run on any anomaly (fail fast, save tokens)."""
    sys.path.insert(0, os.path.join(REPO_ROOT, "benchmark"))
    from audit_sessions import audit
    archive_dir = archive_sessions(dsh_home, tag)
    ok, report = audit(archive_dir)
    report_path = os.path.join(REPO_ROOT, "benchmark", "results", "audit", tag + ".json")
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\n[audit] {tag}: {'PASS' if ok else 'FAIL'} "
          f"(tools: {report['tool_calls']}, denied attempts: {report['denied_attempts']})")
    if not ok:
        raise RuntimeError(
            f"AUDIT FAIL for {tag}: successful non-memory tools or suspicious content found; "
            f"see {report_path}. Aborting the run to save tokens.")


def main():
    args = parse_args()
    config_path = args.dataset_config
    if not os.path.isabs(config_path):
        config_path = os.path.join(ORIG_CWD, config_path)
    with open(config_path) as fh:
        dataset_config = yaml.safe_load(fh)
    dataset_config.setdefault("debug", False)
    agent_config = {
        "agent_name": AGENT_NAME,
        "model": "deepseek-v4-flash",
        "combo": "deepseek-harness sdk profile + memoplus4dsh (default config)",
        "retrieve_num": 8,
    }
    out_path = output_path_for(dataset_config)
    dsh_home = args.dsh_home or os.path.join(REPO_ROOT, "benchmark", "dsh-home")

    stride, offset = args.query_stride, args.query_offset
    if args.run_tag:
        dataset_config["tag"] = args.run_tag
        out_path = output_path_for(dataset_config)
    elif stride > 1:
        # Mini-split runs write to their own result files (never clobber full
        # runs) via the tag component of the official output name.
        dataset_config["tag"] = f"mini-s{stride}-o{offset}"
        out_path = output_path_for(dataset_config)

    start_time = time.time()
    creator = ConversationCreator({"agent_name": AGENT_NAME}, dataset_config)
    all_chunks = creator.get_chunks()
    all_qa = creator.get_query_and_answers()

    metrics, results = defaultdict(list), []
    results, _done = ([], 0) if args.force else load_existing(out_path)
    # Resume is keyed by query_id (works for both full and strided runs).
    done_ids = {entry.get("query_id") for entry in results}
    # Rebuild the metrics accumulator from prior results (same as official).
    for entry in results:
        reconstructed = {
            "output": entry["output"],
            "input_len": entry["input_len"],
            "output_len": entry["output_len"],
            "memory_construction_time": entry.get("memory_construction_time", 0),
            "query_time_len": entry.get("query_time_len", 0),
        }
        answer = entry["answer"][0] if isinstance(entry["answer"], list) else entry["answer"]
        metrics, _ = metrics_summarization(
            reconstructed, entry["query"], answer, dataset_config,
            metrics, [], entry.get("query_id"), entry.get("qa_pair_id"))

    query_index = 0
    time_cost_list = []
    for context_index, (chunks, qa_pairs) in enumerate(zip(all_chunks, all_qa)):
        if args.max_contexts > 0 and context_index >= args.max_contexts:
            break
        if args.max_queries > 0 and query_index >= args.max_queries:
            break

        # Skip fully-completed contexts when resuming (without paying ingest).
        context_query_start = query_index
        query_index_end = query_index + len(qa_pairs)
        selected = [i for i in range(len(qa_pairs))
                    if stride <= 1 or i % stride == offset]
        if selected and all(context_query_start + i in done_ids for i in selected):
            query_index = query_index_end
            continue

        print(f"\n===== context {context_index}: {len(chunks)} chunks, "
              f"{len(selected)}/{len(qa_pairs)} queries =====")
        wipe_memory_state(dsh_home)

        memorize_template = get_template(dataset_config["sub_dataset"], "memorize", AGENT_NAME)
        formatted = [
            memorize_template.format(
                context=chunk,
                **({"time_stamp": time.strftime("%Y-%m-%d %H:%M:%S")}
                   if "{time_stamp}" in memorize_template else {}),
            )
            for chunk in chunks
        ]

        with MemoplusDshAgent(REPO_ROOT, context_tag=f"{dataset_config['sub_dataset']}-{context_index}", dsh_home=dsh_home) as agent:
            construction_time = agent.memorize(formatted)
            for local_q_idx, qa in enumerate(tqdm(qa_pairs, desc="queries")):
                if stride > 1 and local_q_idx % stride != offset:
                    continue
                query, answer, qa_pair_id = qa if len(qa) == 3 else (*qa, None)
                if context_query_start + local_q_idx in done_ids:
                    continue
                query_template = get_template(dataset_config["sub_dataset"], "query", AGENT_NAME)
                wrapped = query_template.format(question=query)
                out = agent.ask(wrapped)
                out["memory_construction_time"] = construction_time
                metrics, results = metrics_summarization(
                    out, query, answer, dataset_config, metrics, results,
                    context_query_start + local_q_idx, qa_pair_id)
                save_results(out_path, agent_config, dataset_config, results,
                             metrics, time_cost_list, start_time)
                if args.max_queries > 0 and (context_query_start + local_q_idx + 1) >= args.max_queries:
                    break
        # Per-context audit (user requirement: 跑一次审计一次): archive the
        # session logs and verify no answer came from anything but memory.
        audit_context(dsh_home, f"{dataset_config['sub_dataset']}-ctx{context_index}")
        query_index = query_index_end

    print(f"\nResults: {out_path}")
    with open(out_path) as fh:
        print(json.dumps(json.load(fh)["averaged_metrics"], indent=2))


if __name__ == "__main__":
    main()
