#!/usr/bin/env bash
# run-lme.sh — Accurate_Retrieval/LongMemEval（longmemeval_s*，官方默认 5 samples）。
# 使用独立的第二个 dsh-home，可与 run-cr-all.sh 并行。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

LME_HOME="$(pwd)/dsh-home-lme"

for cfg in \
  Accurate_Retrieval/LongMemEval/Longmemeval_s_star.yaml
do
  echo "================ $cfg ================"
  ./venv/bin/python run_benchmark.py \
    --dataset_config "MemoryAgentBench/configs/data_conf/$cfg" \
    --dsh_home "$LME_HOME" || echo "FAILED: $cfg"
done
echo "ALL DONE"
