#!/usr/bin/env bash
# run-smoke.sh — 最低成本端到端冒烟：1 个 context（sh_6k，2 chunks）+ 5 题。
#
# 用途：改完代码后花一两分钟确认"ingest→抽取→注入/检索→回答"整条链路活着。
# 不用于评估分数（n=5 太小），只看是否全跑通 + 审计 PASS。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

# 每轮全新 tag：smoke 的目的是验证"当前代码"的链路，断点续跑会跳过已完成的题，
# 起不到验证作用。
TAG="smoke-$(date +%m%d-%H%M)"

./venv/bin/python run_benchmark.py \
  --dataset_config MemoryAgentBench/configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml \
  --query_stride 20 --query_offset 0 --run_tag "$TAG" \
  || { echo "SMOKE FAILED"; exit 1; }
echo "SMOKE OK (tag: $TAG)"
