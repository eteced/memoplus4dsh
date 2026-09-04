#!/usr/bin/env bash
# run-mini.sh — 敏捷迭代用的小样评测（按场景维度降采样，不是全量 ingest + 少题）。
#
# 降采样策略（token 大头在 ingest，所以砍 context 而不是只砍题）：
# - CR：只跑 6k 和 32k 两档长度（64k/262k 留给里程碑评测），
#   每 config 题内 stride 10 → 4 configs × 10 题 = 40 题。
#   注意：CR 各长度题目互不重叠（已验证），6k/32k 与长档题目不同但题型同构，
#   迭代间对比只看 mini 自身分数的变化。
# - LME：官方 max_test_samples 采样语义取第 1 个 context（ingest 降为 1/5），
#   题内 stride 6 → 10 题。
# - 合计 ~50 题；ingest ≈ 全量的 5% 左右，query ≈ 4.5%。
# - 结果写独立文件（tag=mini-*），不覆盖全量结果；断点续跑按 query_id。
# - mini 分数只用于迭代方向验证，不可与全量/基线直接比较。
set -uo pipefail
cd "$(dirname "$0")"

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"

STRIDE="${MINI_STRIDE:-10}"
OFFSET="${MINI_OFFSET:-0}"
LENGTHS="${MINI_LENGTHS:-6k 32k}"
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
  --query_stride 6 --query_offset "$OFFSET" "${TAG_ARGS[@]}" \
  || { echo "FAILED (aborting): LME"; exit 1; }

echo "MINI RUN ALL DONE (lengths: $LENGTHS, stride=$STRIDE offset=$OFFSET)"
