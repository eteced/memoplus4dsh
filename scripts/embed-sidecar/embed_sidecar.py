#!/usr/bin/env python3
"""
embed_sidecar.py — harrier-oss-v1-0.6b 嵌入 sidecar，stdio JSON-lines 协议。

输入行:  {"id": N, "texts": ["..."], "prompt": "web_search_query" | null}
输出行:  {"id": N, "vectors": [[float, ...], ...]}
启动行:  {"ready": true, "model": "...", "dim": 1024}

模型：microsoft/harrier-oss-v1-0.6b（多语言，MTEB v2 69.0，1024 维）。
查询侧用 prompt_name 加指令（模型训练方式）；文档侧不加。
"""

import json
import os
import sys

MODEL = os.environ.get("EMBED_MODEL", "microsoft/harrier-oss-v1-0.6b")


def main():
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print(json.dumps({"ready": False, "error": "sentence-transformers not installed"}), flush=True)
        sys.exit(2)
    model = SentenceTransformer(MODEL)
    dim = int(model.get_sentence_embedding_dimension())
    print(json.dumps({"ready": True, "model": MODEL, "dim": dim}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            kwargs = {}
            if req.get("prompt"):
                kwargs["prompt_name"] = req["prompt"]
            vecs = model.encode(req["texts"], **kwargs)
            # 4 位小数足够余弦排序（响应体积减半）
            out = [[round(float(x), 4) for x in vec] for vec in vecs]
            print(json.dumps({"id": req.get("id"), "vectors": out}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"id": req.get("id"), "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
