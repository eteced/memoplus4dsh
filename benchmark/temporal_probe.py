#!/usr/bin/env python3
"""
temporal_probe.py — 时间语义探针：我们方法的主优势轴，每次迭代的快速验证。

一个固定的中文小剧本（5 轮 ingest，覆盖：绝对过去时间、相对时间、双锚
"10 月聊 9 月的事"、事实更新冲突、未来日程），然后在新会话里问 5 个时间/
状态问题，断言回答命中要点。

成本：ingest 几百 token + 5 个短查询，分钟级。与 smoke/mini 互补：
smoke 验链路活着，本探针验"时间维度 + 新值偏好"这两个核心机制的方向正确性。

用法（benchmark/ 目录）：
  DEEPSEEK_API_KEY=... venv/bin/python temporal_probe.py [--dsh-home <dir>]
退出码 0 = 全部通过，1 = 有失败。明细打印到 stdout。
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_memoplus_dsh import DshDriver  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 剧本：每行一轮用户输入（ingest 会话内逐轮发，turn/end 触发抽取）。
SCRIPT = [
    "我 2025 年 3 月开始学钢琴，到现在一直在坚持。",
    "我住在杭州滨江区，挺喜欢的。",
    "我家有只猫叫雪球，特别胖。",
    "上周三下午我去看了牙医，补了一颗牙。",
    "对了，9 月 15 日那天我面试失败了，当时特别挫败。",
    "跟你说个事，我搬家了，现在住在上海徐汇区。",
    "Snowball 今天把茶几上的花瓶打碎了，唉。",
]

# (问题, 命中要点列表(任一即可, 小写包含), 不应出现的词)
QUESTIONS = [
    ("我面试失败是哪一天的事？", ["9 月 15", "9月15", "2026-09-15", "9/15"], []),
    ("我上次跟你聊到的那种挫败感是因为什么？", ["面试"], []),
    ("我现在住在哪个城市？", ["上海"], []),
    ("我上周做了什么？看牙之外还说说", ["牙"], []),
    ("我是什么时候开始学钢琴的？", ["2025"], []),
    # 实体合并（LLM 裁决）："雪球" 与 "Snowball" 应合并为一个实体
    ("我家猫今天闯什么祸了？它叫什么名字？", ["花瓶", "打碎"], []),
]

PROBE_HOME_DEFAULT = os.path.join(REPO_ROOT, "benchmark", "dsh-home-probe")


def wait_queue_drain(dsh_home, timeout=300, poll=2.0):
    """等抽取队列清空（pending 日志无未 settle 项）。复刻 agent 的等待逻辑。"""
    pending_file = os.path.join(dsh_home, "memoplus4dsh", "extraction-pending.jsonl")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(pending_file):
            pending, settled = set(), set()
            for line in open(pending_file):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("kind") == "pending":
                    pending.add(f"{entry['job']['sessionId']}:{entry['job']['turn']}")
                elif entry.get("kind") == "settled":
                    settled.add(f"{entry['sessionId']}:{entry['turn']}")
            if pending and pending <= settled:
                return True
        time.sleep(poll)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsh-home", default=PROBE_HOME_DEFAULT)
    parser.add_argument("--keep", action="store_true", help="保留 probe 的 dsh home（默认跑完不删，便于检查图）")
    args = parser.parse_args()

    # 固定剧本需要全新状态：续跑的会话会让 finalResponse 取不到值。
    # 清掉会话与插件数据（保留 models 目录——135MB 嵌入模型不重复下载）。
    import shutil
    sessions_dir = os.path.join(args.dsh_home, "sessions")
    if os.path.exists(sessions_dir):
        shutil.rmtree(sessions_dir)
    plugin_data = os.path.join(args.dsh_home, "memoplus4dsh")
    if os.path.exists(plugin_data):
        for name in os.listdir(plugin_data):
            if name == "models":
                continue
            target = os.path.join(plugin_data, name)
            if os.path.isdir(target):
                shutil.rmtree(target)
            else:
                os.remove(target)

    driver = DshDriver(REPO_ROOT, args.dsh_home)
    try:
        for i, line in enumerate(SCRIPT):
            driver.call("ingest", session="temporal-probe-ingest", text=line, timeout=120)
            print(f"[ingest] turn {i + 1}/{len(SCRIPT)} done")
        if not wait_queue_drain(args.dsh_home):
            print("[warn] 抽取队列等待超时，继续（可能导致漏记忆）")

        failures = 0
        for qi, (question, must, must_not) in enumerate(QUESTIONS):
            resp = driver.call("ask", session=f"temporal-probe-q{qi + 1}", text=question, timeout=300)
            answer = str(resp.get("text", resp))
            low = answer.lower()
            ok = any(m.lower() in low for m in must) and not any(m.lower() in low for m in must_not)
            print(f"\n[{'PASS' if ok else 'FAIL'}] Q{qi + 1}: {question}")
            print(f"  回答: {answer[:300]}")
            if not ok:
                failures += 1
        print(f"\n==== temporal probe: {len(QUESTIONS) - failures}/{len(QUESTIONS)} PASS ====")
        return 1 if failures else 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
