#!/usr/bin/env bash
# run-cr-all.sh — Conflict_Resolution 全量（sh/mh × 6k/32k/64k/262k，各 1 context）。
# 断点续跑：每个 config 独立结果文件，重启脚本自动跳过已完成的 context。
# FULL_TAG=<轮次>：结果文件加轮次标签（重跑全量必须用新 tag，否则会断点续跑
# 旧代码的结果而不是真正重跑；旧结果保留用于横向对比）。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

TAG_ARGS=()
if [[ -n "${FULL_TAG:-}" ]]; then TAG_ARGS=(--run_tag "$FULL_TAG"); fi

for cfg in \
  Conflict_Resolution/Factconsolidation_sh_6k.yaml \
  Conflict_Resolution/Factconsolidation_sh_32k.yaml \
  Conflict_Resolution/Factconsolidation_sh_64k.yaml \
  Conflict_Resolution/Factconsolidation_sh_262k.yaml \
  Conflict_Resolution/Factconsolidation_mh_6k.yaml \
  Conflict_Resolution/Factconsolidation_mh_32k.yaml \
  Conflict_Resolution/Factconsolidation_mh_64k.yaml \
  Conflict_Resolution/Factconsolidation_mh_262k.yaml
do
  echo "================ $cfg ================"
  ./venv/bin/python run_benchmark.py \
    --dataset_config "MemoryAgentBench/configs/data_conf/$cfg" "${TAG_ARGS[@]}" || { echo "FAILED (aborting): $cfg"; exit 1; }
done
echo "ALL DONE"
