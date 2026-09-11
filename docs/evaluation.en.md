# Evaluation Record (MemoryAgentBench)

> 中文：[evaluation.md](evaluation.md)

Archived evaluation record for the memoplus4dsh + deepseek-harness (dsh) combo on
MemoryAgentBench: the valid baseline (r1) vs the full rerun after improvements (r2),
recall attribution, engineering metrics, and audit/integrity notes. Raw result files,
session archives, and per-question attribution data are kept locally under
`benchmark/results/` (gitignored, not uploaded to the public repo).

## 1. Setup

| Item | Value |
|---|---|
| System under test | dsh sdk profile + memoplus4dsh (default config) |
| Skeleton model | deepseek-v4-flash @ DeepSeek official API |
| dsh version | r1: 0.1.2-alpha.3; r2: 0.1.5-alpha.2 |
| Benchmark | MemoryAgentBench official repo (commit `fe1735d`); data loading, templates, and metric computation unmodified |
| Tasks | Conflict_Resolution (FC-SH / FC-MH × 6k/32k/64k/262k, 100 questions each), LongMemEval(S*) (300 questions) |
| Query protocol | one fresh dsh session per question, memory shared via the graph (aligned with the official stateless RAG-agent protocol) |
| Fairness guards | tool whitelist (no fs/network tools), per-context session archiving, abort memorize on zero extraction events |
| r1 date | 2026-09-03 (M9 run-2; run-1 invalidated by audit) |
| r2 date | 2026-09-09 ~ 09-11 (full rerun after M11–M17) |

## 2. Headline results (r1 → r2)

Conflict_Resolution, rule-based exact_match, n=100 per config:

| config | r1 | r2 | Δ |
|---|---|---|---|
| FC-SH 6k | 63.0 | **89.0** | +26.0 |
| FC-SH 32k | 52.0 | **78.0** | +26.0 |
| FC-SH 64k | 59.0 | **90.0** | +31.0 |
| FC-SH 262k | 57.0 | **83.0** | +26.0 |
| **FC-SH avg** | 57.75 | **85.0** | **+27.25** |
| FC-MH 6k | 28.0 | **31.0** | +3.0 |
| FC-MH 32k | 38.0 | **66.0** | +28.0 |
| FC-MH 64k | 35.0 | **55.0** | +20.0 |
| FC-MH 262k | 20.0 | **54.0** | +34.0 |
| **FC-MH avg** | 30.25 | **51.5** | **+21.25** |

LongMemEval(S*), n=300:

| Metric | r1 | r2 |
|---|---|---|
| LLM-judge accuracy (official primary) | 56.67 | **68.33** |
| exact_match (rule-based, reference) | 18.3 | 24.0 |
| F1 (rule-based, reference) | 35.2 | 44.1 |

> The official LME metric is the LLM judge (`longmem_qa_evaluate.py`, judge model
> deepseek-v4-flash); rule-based EM is sensitive to answer brevity and is reported
> for reference only. r1 judge breakdown: multi-session 42.7 /
> single-session-user 82.2 / single-session-assistant 60.0 /
> temporal-reasoning 52.0 / knowledge-update 62.2 / preference 53.3.

## 3. vs official baselines (paper Table 2, arXiv:2507.05257v2)

Official baselines use a GPT-4o-mini skeleton; this combo uses deepseek-v4-flash —
model capability differences are mixed into the comparison.

- **FC-SH**: best official memory/RAG agent HippoRAG-v2 54.0, BM25 48.0, Mem0 18.0;
  GPT-4o long-context 60.0. r2 avg **85.0** beats every baseline including the
  long-context approach.
- **FC-MH**: all official baselines ≤7.0; o4-mini scores 80.0 at 6k but collapses
  to 14.0 at 32k. r2 avg **51.5**, still **54.0** at 262k — the only memory system
  that does not fail on long-context multi-hop forgetting.
- **LME(S\*)**: official range 15.7 (Contriever) – 55.7 (GPT-4.1-mini); best RAG
  HippoRAG-v2 50.7. r2 judge **68.33**, 12.6 points above the official best and
  first overall (r1's 56.67 already beat every baseline).

r2 judge by question type: single-session-user 91.1 / knowledge-update 73.3 /
preference 70.0 / single-session-assistant 66.7 / temporal-reasoning 61.3 /
multi-session 58.7.

## 4. r2 recall attribution (1027 checkable questions)

For each question, was a fact supporting the correct answer ever placed in front of
the model?

| Slice | injected (pre-step) | recovered by search | final recall |
|---|---|---|---|
| All (n=1027) | 53.6% | +20.7% | **74.3%** |
| FC-SH (avg) | 89.7% | +4.0% | 93.7% |
| FC-MH (avg) | 29.8% | +49.7% | 79.5% |
| LME | 32.2% | 0% | 32.2% |

- FC-MH injection coverage is inherently low (answers are spread over multi-hop
  chains), but the model — guided by the system prompt — iterates `memory_search`
  on its own: recall on mh_64k rises from 22.2% to **85.9%**, mh_32k from 26.0%
  to 80.0%. The multi-hop retrieval strategy works.
- 328 failed questions: model-side (injected but answered wrong) 85, found but not
  used 70, pure retrieval failure (searched, still missed) 59, injection failure
  (never searched) 114.
- **Largest remaining gap**: 56 of 67 never-recalled LME questions are write-chain
  losses (extraction misses) — extraction recall is the top direction for the next
  iteration, followed by mh_6k injection coverage (56%).

## 5. Engineering metrics (r2)

Build = time to memorize the full context; query = total time over all questions
(seconds):

| config | EM | build (s) | query total (s) | per question (s) |
|---|---|---|---|---|
| FC-SH 6k | 89.0 | 125 | 1667 | 16.7 |
| FC-SH 32k | 78.0 | 483 | 1056 | 10.6 |
| FC-SH 64k | 90.0 | 723 | 1037 | 10.4 |
| FC-SH 262k | 83.0 | 3395 | 1510 | 15.1 |
| FC-MH 6k | 31.0 | 109 | 5785 | 57.9 |
| FC-MH 32k | 66.0 | 285 | 5694 | 56.9 |
| FC-MH 64k | 55.0 | 442 | 5719 | 57.2 |
| FC-MH 262k | 54.0 | 2516 | 8563 | 85.6 |
| LME | 24.0 | 1704 | 3681 | 12.3 |

FC-MH per-question latency is much higher than FC-SH (~57s vs ~12s) due to multiple
rounds of `memory_search` hopping — the direct cost of the score gains, as expected.

## 6. Audit & integrity

- All r1/r2 configs audit-PASS; r2 ran with zero RuntimeErrors and zero guard trips.
- A tool whitelist blocks every non-memory tool (fs/network), eliminating
  "read the dataset file for the answer" leaks (run-1 was invalidated and rerun for
  exactly that reason).
- Per-context sessions and memory-graph snapshots are archived under
  `benchmark/results/sessions-archive/`; per-question attribution lives in
  `benchmark/results/analysis/` (`r2-final-attribution.txt`,
  `recall-attribution.json`) — every answer's memory provenance is auditable.
- Runs respected the 09:00–18:00 (Beijing) API peak-hours ban via cron-driven
  pause/resume with checkpoint restart and no duplicate spend.

## 7. Reproduce

```sh
cd benchmark
export DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
FULL_TAG=<tag> ./run-cr-all.sh   # Conflict_Resolution, 8 configs, checkpoint resume
FULL_TAG=<tag> ./run-lme.sh      # LongMemEval(S*) n=300
./venv/bin/python analyze_recall_failures.py <tag> <tag>   # recall attribution
# official LME judge:
DEEPSEEK_API_KEY=... ./venv/bin/python judge_lme.py --hyp_file results/Accurate_Retrieval/*<tag>*_results.json
```
