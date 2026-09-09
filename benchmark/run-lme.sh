#!/usr/bin/env bash
# run-lme.sh — Accurate_Retrieval/LongMemEval（longmemeval_s*，官方默认 5 samples）。
# 使用独立的第二个 dsh-home，可与 run-cr-all.sh 并行。
# FULL_TAG=<轮次>：见 run-cr-all.sh 头部说明（重跑全量必须带新 tag）。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

LME_HOME="$(pwd)/dsh-home-lme"

TAG_ARGS=()
if [[ -n "${FULL_TAG:-}" ]]; then TAG_ARGS=(--run_tag "$FULL_TAG"); fi

for cfg in \
  Accurate_Retrieval/LongMemEval/Longmemeval_s_star.yaml
do
  echo "================ $cfg ================"
  ./venv/bin/python run_benchmark.py \
    --dataset_config "MemoryAgentBench/configs/data_conf/$cfg" \
    --dsh_home "$LME_HOME" "${TAG_ARGS[@]}" || { echo "FAILED (aborting): $cfg"; exit 1; }
done
echo "ALL DONE"
