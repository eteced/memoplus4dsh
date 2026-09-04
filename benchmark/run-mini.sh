#!/usr/bin/env bash
# run-mini.sh — 敏捷迭代用的小样评测（按场景维度降采样，不是全量 ingest + 少题）。
#
# 降采样策略（token 大头在 ingest，所以砍 context 而不是只砍题）：
# - CR：默认只跑 6k 档（更长的档留给里程碑评测），题内 stride 20 → 2 configs × 5 题 = 10 题。
#   注意：CR 各长度题目互不重叠（已验证），mini 与长档题目不同但题型同构，
#   迭代间对比只看 mini 自身分数的变化。
# - LME：官方 max_test_samples 采样语义取第 1 个 context（ingest 降为 1/5），
#   题内 stride 12 → 5 题。
# - 合计 15 题（默认）；ingest ≈ 全量的 2~3%，query 更少。
# - 结果写独立文件（tag=mini-* 或 MINI_TAG 轮次标签），不覆盖全量结果；断点续跑按 query_id。
# - mini 分数只用于迭代方向验证，不可与全量/基线直接比较。
# - 更快的一档：run-smoke.sh（1 context + 5 题，分钟级，只验证链路活着）。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

# Mini（默认再减半：只跑 6k 档 + stride 20 → CR 10 题；LME 1 context + stride 12 → 5 题）：
STRIDE="${MINI_STRIDE:-20}"
OFFSET="${MINI_OFFSET:-0}"
LENGTHS="${MINI_LENGTHS:-6k}"
LME_STRIDE="${MINI_LME_STRIDE:-12}"
# 迭代轮次标签（如 MINI_TAG=m11v2）：隔离每轮结果文件，便于逐轮对比。
TAG_ARGS=()
if [[ -n "${MINI_TAG:-}" ]]; then TAG_ARGS=(--run_tag "$MINI_TAG"); fi

for len in $LENGTHS; do
  for kind in sh mh; do
    cfg="Conflict_Resolution/Factconsolidation_${kind}_${len}.yaml"
    echo "================ $cfg ================"
    ./venv/bin/python run_benchmark.py \
      --dataset_config "MemoryAgentBench/configs/data_conf/$cfg" \
      --query_stride "$STRIDE" --query_offset "$OFFSET" "${TAG_ARGS[@]}" \
      || { echo "FAILED (aborting): $cfg"; exit 1; }
  done
done

echo "================ LME mini (1 context) ================"
./venv/bin/python run_benchmark.py \
  --dataset_config configs/Longmemeval_s_star_mini.yaml \
  --dsh_home "$(pwd)/dsh-home-lme" \
  --query_stride "$LME_STRIDE" --query_offset "$OFFSET" "${TAG_ARGS[@]}" \
  || { echo "FAILED (aborting): LME"; exit 1; }

echo "MINI RUN ALL DONE (lengths: $LENGTHS, stride=$STRIDE offset=$OFFSET)"
