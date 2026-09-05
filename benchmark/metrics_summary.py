#!/usr/bin/env python3
"""
metrics_summary.py — 记忆插件工程指标汇总（m14，用户要求的三类指标）。

对一轮 mini/full 评测（按结果文件名 tag）聚合：
1. 时延：ingest 墙钟（memory_construction_time）、单题查询耗时分布；
2. 建图 token 开销：ingest 会话的 LLM 用量（input/output tokens，会话日志
   usage chunk 实计）+ 抽取输入字符估算（extraction-debug.jsonl，chars/4）；
3. 查询时 token 节约：全量上下文基线（context 字符 → tokens 估算）vs
   实际每题注入+工具调用消耗。

用法：venv/bin/python metrics_summary.py <tag>    如 m13v1
"""

import glob
import json
import os
import sys

import zstandard

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
ARCHIVE = os.path.join(RESULTS, "sessions-archive")


def load_zstd_lines(path):
    dctx = zstandard.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as r:
        return r.read().decode().split("\n")


def session_usage(path):
    """(kind, input_tokens, output_tokens)；kind: ingest / query"""
    base = os.path.basename(os.path.dirname(path))
    kind = "ingest" if "-ingest-" in base else "query"
    inp = out = 0
    for line in load_zstd_lines(path):
        if '"usage"' not in line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant/chunk":
            chunk = ev.get("data", {}).get("chunk", {})
            if chunk.get("type") == "usage":
                u = chunk.get("usage", {})
                inp += u.get("inputTokens", 0)
                out += u.get("outputTokens", 0)
    return kind, inp, out


def main():
    tag = sys.argv[1]
    archives = sorted(glob.glob(os.path.join(ARCHIVE, f"*-{tag}-ctx*")))
    if not archives:
        print(f"无 tag={tag} 的归档")
        return
    for adir in archives:
        name = os.path.basename(adir)
        ingest_tokens = {"input": 0, "output": 0}
        query_tokens = {"input": 0, "output": 0}
        n_queries = 0
        for f in glob.glob(os.path.join(adir, "**", "session.jsonl.zstd"), recursive=True):
            kind, inp, out = session_usage(f)
            target = ingest_tokens if kind == "ingest" else query_tokens
            target["input"] += inp
            target["output"] += out
            if kind == "query":
                n_queries += 1
        # 抽取输入字符估算（插件侧 LLM 调用：抽取/裁决/扩展）
        ext_chars = 0
        debug = os.path.join(adir, "extraction-debug.jsonl")
        if os.path.exists(debug):
            for line in open(debug):
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("kind") == "enqueue":
                    ext_chars += e.get("textChars", 0)
        print(f"\n== {name} ==")
        print(f"  建图 LLM 用量（会话实计）: input={ingest_tokens['input']:,} output={ingest_tokens['output']:,}")
        print(f"  抽取输入（chars 估算）: {ext_chars:,} → ≈{ext_chars // 4:,} tokens")
        if n_queries:
            print(f"  查询 LLM 用量（{n_queries} 题）: input={query_tokens['input']:,} output={query_tokens['output']:,},"
                  f" 均摊 {query_tokens['input'] // n_queries:,}+out {query_tokens['output'] // n_queries:,}/题")

    # 结果文件里的时延 + 节约估算
    for f in sorted(glob.glob(os.path.join(RESULTS, "*", f"*{tag}*.json"))) + \
            sorted(glob.glob(os.path.join(RESULTS, "*", "*", f"*{tag}*.json"))):
        data = json.load(open(f))
        entries = data.get("data", [])
        if not entries:
            continue
        cfg = os.path.basename(f)[:24]
        mc = entries[0].get("memory_construction_time", 0)
        qts = [e["query_time_len"] for e in entries]
        inj = sum(len(e.get("injected", "")) for e in entries) / len(entries)
        ctx_len = data["dataset_config"].get("context_max_length", 0)
        # 节约：全量上下文塞入的 token 估算 vs 实际每题消耗
        print(f"\n[{cfg}] ingest={mc:.0f}s | 查询 min/avg/max = {min(qts):.0f}/{sum(qts)/len(qts):.0f}/{max(qts):.0f}s")
        print(f"  注入块均长 {inj:.0f} chars | 全量上下文 ≈{ctx_len // 4:,} tokens/题（长上下文基线）"
              f" vs 实际注入 ≈{inj // 4:.0f} tokens/题")


if __name__ == "__main__":
    main()
