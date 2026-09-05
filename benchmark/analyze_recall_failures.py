#!/usr/bin/env python3
"""
analyze_recall_failures.py — run-2 结果的召回归因分析（零 API 消耗，纯本地）。

对每个问题判定：支持正确答案的事实是否曾出现在模型面前——
  injected      pre-step 注入块里已有（记忆系统已尽到责任；答错是模型侧问题）
  searched      注入没有，但某次 memory_search 的结果里有（注入排序弱点；模型未利用）
  never         注入与全部 memory_search 结果都没有（记忆系统召回失败）
    ├─ never+searched    模型主动搜过仍没召回 → 纯检索失败
    └─ never+no-search   模型没搜过 → 注入失败（模型未主动回忆是模型侧）

对 never 的 CR case 再对照 dsh-home 终态记忆图（CR 各 config 共享事实池，
已验证四个长度档的答案词 20/20 在图中）：
  extraction-miss   图中无含答案的事件 → 写入链路（抽取）丢失
  retrieval-miss    图中有但从未召回 → 读取链路（打分/过滤）问题

答案词太短/纯数字的 LME case 无法用语义包含判定，标记 unverifiable 不计入比例。

输出：results/analysis/recall-attribution.json（逐 case）+ stdout 汇总。
用法：venv/bin/python analyze_recall_failures.py [结果文件名过滤子串]
  默认分析全量结果；分析 mini run 用：analyze_recall_failures.py mini-s
（mini 结果的图归因需要使用该轮归档的 per-context 图，本脚本读的是终态图，
  对 mini/非共享池结果的图归因仅供参考。）
"""

import glob
import json
import os
import re
import sys
import unicodedata

import zstandard

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
ARCHIVE = os.path.join(RESULTS, "sessions-archive")
CR_GRAPH = os.path.join(HERE, "dsh-home", "memoplus4dsh", "memory-graph.jsonl")
LME_GRAPH = os.path.join(HERE, "dsh-home-lme", "memoplus4dsh", "memory-graph.jsonl")
OUT_DIR = os.path.join(RESULTS, "analysis")


def norm(s):
    """大小写/重音/标点/空白不敏感的包含匹配用归一化。"""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9一-鿿]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def verifiable(answer):
    """答案词足够特异，包含匹配才有意义。"""
    n = norm(answer)
    return len(n) >= 4 and not n.isdigit()


# 查询里的"内容词"（≥5 字符的非通用词），用于图内事件的答案+实体共现检查
GENERIC = set("""based provided knowledge pool question answer what which where when
language country religion name current head government state speak speaks spoken
official officially predominantly associated citizenship notable works works
write wrote written play plays played position sport team""".split())


def query_content_words(query):
    words = [w for w in norm(query).split() if len(w) >= 5 and w not in GENERIC]
    return set(words)


def graph_lookup(graph_events, answers, content_words):
    """图内是否存在"含答案词且含查询内容词"的单条事件（比全图 substring 严格）。
    MH 末跳事实可能不含查询词，故同时回报仅含答案的弱证据。"""
    strong, weak = [], []
    for ev in graph_events:
        text = norm(f"{ev.get('predicate', '')} {ev.get('normalizedText', '')} {ev.get('details', '')}")
        hit = [a for a in answers if verifiable(a) and norm(a) in text]
        if not hit:
            continue
        weak.append(ev["normalizedText"])
        if content_words & set(text.split()):
            strong.append(ev["normalizedText"])
    return strong, weak


def load_graph_events(path):
    events = []
    if not os.path.exists(path):
        return events
    for line in open(path):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("op") == "event.add":
            events.append(rec["data"])
    return events


def load_zstd_jsonl(path):
    dctx = zstandard.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as r:
        text = r.read().decode()
    events = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def session_file(sub_dataset, query_id, archive_tag=None):
    # driver 的会话命名是 1-based（agent_memoplus_dsh.py 先 += 1 再命名），
    # query_id 是 0-based —— bench-q{query_id+1} 才是该题的会话。
    # 归档目录带轮次标签（如 factconsolidation_sh_6k-m11v2-ctx0）；
    # archive_tag=None 兼容无标签的旧归档（{sub}-ctx0）。
    mid = f"-{archive_tag}" if archive_tag else ""
    pattern = os.path.join(
        ARCHIVE, f"{sub_dataset}{mid}-ctx*", "**", f"bench-q{query_id + 1}-*", "session.jsonl.zstd")
    hits = glob.glob(pattern, recursive=True)
    return hits[0] if hits else None


def search_activity(events):
    """该会话里 memory_search 的 (queries, 全部结果文本)。"""
    call_ids = []
    queries = []
    for ev in events:
        if ev.get("type") == "tool/call" and ev.get("data", {}).get("name") == "memory_search":
            call_ids.append(ev["data"]["callId"])
            try:
                queries.append(json.loads(ev["data"].get("arguments", "{}")).get("query", ""))
            except json.JSONDecodeError:
                queries.append("")
    texts = []
    idset = set(call_ids)
    for ev in events:
        if ev.get("type") != "tool/result":
            continue
        msg = ev.get("data", {}).get("message", {})
        for block in msg.get("content", []):
            if block.get("type") == "tool-result" and block.get("toolCallId") in idset:
                for inner in block.get("content", []):
                    if inner.get("type") == "text":
                        texts.append(inner["text"])
    return queries, "\n".join(texts)


def any_answer_in(answers, text):
    ntext = norm(text)
    return [a for a in answers if verifiable(a) and norm(a) in ntext]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    graph_events = {
        "cr": load_graph_events(CR_GRAPH),
        "lme": load_graph_events(LME_GRAPH),
    }

    name_filter = sys.argv[1] if len(sys.argv) > 1 else ""
    archive_tag = sys.argv[2] if len(sys.argv) > 2 else None
    cases = []
    for path in sorted(glob.glob(os.path.join(RESULTS, "Conflict_Resolution", "*.json"))) + \
            sorted(glob.glob(os.path.join(RESULTS, "Accurate_Retrieval", "*.json"))):
        if name_filter and name_filter not in os.path.basename(path):
            continue
        if not name_filter and "_None_" not in os.path.basename(path):
            continue  # 默认只分析全量结果（tag=None）；mini/轮次结果用过滤参数指定
        data = json.load(open(path))
        sub = data["dataset_config"]["sub_dataset"]
        is_lme = data["dataset_config"]["dataset"] == "Accurate_Retrieval"
        judged = None
        if is_lme:
            # judge 文件按结果文件名 tag 匹配：run-2 在 results/judge-run2，
            # mini 轮次在 outputs/longmemeval_s*/（judge_lme.py 的 --hyp_file 子集模式产物）
            name_tag = os.path.basename(path).replace("_results.json", "")
            candidates = (
                glob.glob(os.path.join(RESULTS, "judge-run2", "*", f".eval-results-*{name_tag}*"))
                + glob.glob(os.path.join(HERE, "outputs", "longmemeval_s*", f".eval-results-*{name_tag}*"))
            )
            # run-2 全量的老命名（无 tag 匹配时回退唯一文件且仅当数量一致）
            if not candidates:
                fallback = glob.glob(os.path.join(RESULTS, "judge-run2", "*", ".eval-results-*"))
                candidates = [f for f in fallback
                              if len([l for l in open(f) if l.strip()]) == len(data["data"])]
            if not candidates:
                print(f"[warn] {sub}: 无匹配 judge 文件，跳过 LME 判分（failed 记 None）")
                judged = None
            else:
                judged = [json.loads(l) for l in open(candidates[0]) if l.strip()]
                if len(judged) != len(data["data"]):
                    print(f"[warn] {sub}: judge 数 {len(judged)} != 结果数 {len(data['data'])}，跳过")
                    judged = None
        for i, entry in enumerate(data["data"]):
            answers = entry["answer"] if isinstance(entry["answer"], list) else [entry["answer"]]
            failed = (not judged[i]["autoeval_label"]["label"]) if (is_lme and judged is not None) else \
                (None if is_lme else (not entry["exact_match"]))
            checkable = [a for a in answers if verifiable(a)]
            case = {
                "config": sub, "query_id": entry.get("query_id"),
                "query": entry["query"][-400:], "answers": answers,
                "model_output": entry["parsed_output"], "failed": failed,
            }
            if not checkable:
                case["verdict"] = "unverifiable"
                cases.append(case)
                continue
            # 1) pre-step 注入
            if any_answer_in(checkable, entry.get("injected", "")):
                case["verdict"] = "failed" if failed else "ok"
                case["recall"] = "injected"
                cases.append(case)
                continue
            # 2) memory_search 结果
            sf = session_file(sub, entry.get("query_id"), archive_tag)
            queries, results_text = ([], "")
            if sf:
                queries, results_text = search_activity(load_zstd_jsonl(sf))
            found = any_answer_in(checkable, results_text)
            case["search_queries"] = queries
            if found:
                case["recall"] = "searched"
            else:
                case["recall"] = "never"
                case["searched_at_all"] = len(queries) > 0
                # 3) 图归因：有轮次标签时用该 context 归档的图（精确）；
                # 否则退回终态图（CR 事实池共享 → 可信；LME 仅最后一个 context）
                evs = None
                scope = "shared-pool"
                if archive_tag:
                    gp = os.path.join(ARCHIVE, f"{sub}-{archive_tag}-ctx0", "memory-graph.jsonl")
                    if os.path.exists(gp):
                        evs = load_graph_events(gp)
                        scope = "archived-context-graph"
                if evs is None:
                    evs = graph_events["lme" if is_lme else "cr"]
                    scope = "final-context-only" if is_lme else "shared-pool"
                if evs:
                    strong, weak = graph_lookup(evs, checkable, query_content_words(entry["query"]))
                    case["graph"] = "has-answer-event" if strong else ("weak-answer-only" if weak else "no-answer")
                    case["graph_hits"] = (strong or weak)[:3]
                    case["graph_scope"] = scope
            case["verdict"] = "failed" if failed else "ok"
            cases.append(case)
            continue

    out = os.path.join(OUT_DIR, "recall-attribution.json")
    with open(out, "w") as fh:
        json.dump(cases, fh, ensure_ascii=False, indent=2)

    # ---- 汇总 ----
    print(f"cases: {len(cases)} -> {out}\n")
    for scope, group in [("ALL", cases)] + [
        (cfg, [c for c in cases if c["config"] == cfg])
        for cfg in sorted({c["config"] for c in cases})
    ]:
        chk = [c for c in group if c.get("verdict") != "unverifiable"]
        if not chk:
            continue
        fails = [c for c in chk if c["verdict"] == "failed"]
        inj = sum(1 for c in chk if c.get("recall") == "injected")
        sea = sum(1 for c in chk if c.get("recall") == "searched")
        nev = sum(1 for c in chk if c.get("recall") == "never")
        f_inj = sum(1 for c in fails if c.get("recall") == "injected")
        f_sea = sum(1 for c in fails if c.get("recall") == "searched")
        f_nev = sum(1 for c in fails if c.get("recall") == "never")
        f_nev_searched = sum(1 for c in fails if c.get("recall") == "never" and c.get("searched_at_all"))
        f_nev_strong = sum(1 for c in fails if c.get("recall") == "never" and c.get("graph") == "has-answer-event")
        f_nev_weak = sum(1 for c in fails if c.get("recall") == "never" and c.get("graph") == "weak-answer-only")
        print(f"[{scope}] checkable={len(chk)} failed={len(fails)}")
        print(f"  recall 全量分布: injected={inj} searched={sea} never={nev} "
              f"(注入召回率 {inj/len(chk)*100:.1f}%, 最终召回率 {(inj+sea)/len(chk)*100:.1f}%)")
        print(f"  失败题归因: 已注入但答错(模型侧)={f_inj} 搜到但未利用={f_sea} 从未召回={f_nev}")
        if f_nev:
            print(f"    从未召回细分: 搜过仍 miss(纯检索失败)={f_nev_searched} 未搜(注入失败)={f_nev - f_nev_searched}")
            print(f"    图归因: 有答案+内容词事件(读取链路)={f_nev_strong} 仅答案弱证据={f_nev_weak} "
                  f"无答案(写入链路)={f_nev - f_nev_strong - f_nev_weak}")
        print()


if __name__ == "__main__":
    main()
