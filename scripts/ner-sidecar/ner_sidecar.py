#!/usr/bin/env python3
"""
ner_sidecar.py — 多引擎 NER sidecar，stdio JSON-lines 协议。

每行输入:  {"id": N, "text": "...", "labels": ["person", ...]}
每行输出:  {"id": N, "entities": [{"text","label","score"}...]}
启动输出:  {"ready": true, "engines": [...]} （全部可用引擎加载完成后）

引擎（NER_ENGINES 环境变量控制，默认 "gliner,stanza"，任一不可用自动跳过）：
- gliner: urchade/gliner_multi-v2.1（零样本，object/concept 覆盖强；中文 span 弱）
  注意不要用 ONNX 导出（GLiNER#270 实测质量降级）。
- stanza: zh-hans / en 按文本自动选择（CJK span 正规；只有 PER/ORG/GPE/DATE 类）

标签归一：统一输出 person/object/concept（stanza 的 ORG→concept、GPE/LOC/FAC→object、
DATE 等时间类丢弃——时间走双锚通道，不是实体）。
"""

import json
import os
import sys

GLINER_MODEL = os.environ.get("NER_MODEL", "urchade/gliner_multi-v2.1")
ENGINES = [e.strip() for e in os.environ.get("NER_ENGINES", "gliner,stanza").split(",") if e.strip()]

# stanza 类型 → 图的三类实体；时间/数量类不是实体，丢弃
STANZA_MAP = {
    "PERSON": "person",
    "ORG": "concept",
    "GPE": "object",
    "LOC": "object",
    "FAC": "object",
    "PRODUCT": "object",
    "WORK_OF_ART": "concept",
    "EVENT": "concept",
}


def has_cjk(text):
    return any('一' <= c <= '鿿' for c in text)


def main():
    engines = {}

    if "gliner" in ENGINES:
        try:
            from gliner import GLiNER
            engines["gliner"] = GLiNER.from_pretrained(GLINER_MODEL)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"engine_error": "gliner", "error": str(error)}), file=sys.stderr, flush=True)

    stanza_pipelines = {}
    if "stanza" in ENGINES:
        try:
            import stanza
            stanza_pipelines["zh"] = stanza.Pipeline(
                "zh-hans", processors="tokenize,ner", verbose=False)
            stanza_pipelines["en"] = stanza.Pipeline(
                "en", processors="tokenize,ner", verbose=False)
            engines["stanza"] = True
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"engine_error": "stanza", "error": str(error)}), file=sys.stderr, flush=True)

    if not engines:
        print(json.dumps({"ready": False, "error": "no engine available"}), flush=True)
        sys.exit(2)
    print(json.dumps({"ready": True, "engines": list(engines)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req["text"]
            labels = req.get("labels") or ["person", "object", "concept"]
            out = []
            if "gliner" in engines:
                for e in engines["gliner"].predict_entities(text, labels):
                    out.append({"text": e["text"], "label": e["label"],
                                "score": float(e.get("score", 1.0)), "engine": "gliner"})
            if "stanza" in engines:
                nlp = stanza_pipelines["zh" if has_cjk(text) else "en"]
                doc = nlp(text)
                for sent in doc.sentences:
                    for e in sent.ents:
                        label = STANZA_MAP.get(e.type)
                        if label is None:
                            continue
                        out.append({"text": e.text, "label": label,
                                    "score": 0.9, "engine": "stanza"})
            # 同文本去重（两引擎重叠时取高分）
            best = {}
            for e in out:
                key = e["text"].lower()
                if key not in best or e["score"] > best[key]["score"]:
                    best[key] = e
            print(json.dumps({"id": req.get("id"),
                              "entities": list(best.values())}, ensure_ascii=False), flush=True)
        except Exception as error:  # noqa: BLE001 — 一行失败不应杀死 sidecar
            print(json.dumps({"id": req.get("id"),
                              "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
