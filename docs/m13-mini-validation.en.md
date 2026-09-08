# M13 — Mini-Set Validation (Memory Plugin Performance Evaluation)

> 中文：[m13-mini-validation.md](m13-mini-validation.md)

> Date: 2026-09-05 · Build: all M11 fixes + M12 NER assistance + three storage fixes + merge hardening
> Set: mini (CR sh/mh 6k, 5 questions each + LME 1 context 5 questions, `MINI_TAG=m13v1`)
> Focus (user requirement): evaluate the performance of the memory plugin itself, not the model's capabilities.

## 1. Memory System Metrics (CR Section, 10 Questions)

| Metric | m13v1 | run-2 baseline (v0) |
|---|---|---|
| Injection recall (SH) | **100%** | 8.0% |
| Injection recall (MH) | 40% | 0% |
| Final recall (SH/MH) | 100% / 60% | ~12% / ~60% |
| Pure retrieval failures (searched but still missed) | **0** | 167 |
| Injected but answered wrong (model side) | 1 | 9 |
| Duplicate-name entity groups | 0 | 2820 |
| Audit (non-memory tool executions) | 0 | 0 |

**Accuracy**: sh_6k 80% (4/5, the only failure model-side), mh_6k **60% (3/5, best ever)**.
The 2 remaining MH questions are deep-chain ones: the model did not proactively search hop by hop (a model-side strategy issue), and 1 of them had weak graph-attributed evidence (the extracted fact was phrased differently).

## 2. Performance (Speed/Cost)

| Metric | m13v1 | Notes |
|---|---|---|
| CR ingest wall time | **107–111s/context** | Faster than m11v7/m12v2 (126–151s) — the net gain from storage fixes exceeded adjudication overhead |
| Per-question query time | sh avg 17s / mh avg 34s | On hard mh questions the model runs multi-round memory_search (detective-mode tail latency, known) |
| LME ingest | ~50min (serial extraction + adjudication) | Drain timeout once caused an abort (1800s budget insufficient); raised to 7200s |

## 3. LME Section

- **judge 100% (5/5)**, temporal-reasoning 2/2 (historical trajectory: mini-1 60% → mini-5 80% → m13v1 100%; subset question groups differ, so treat as directional reference only).
- Injection recall **100%** (4/4 judgeable).
- Audit PASS (0 non-memory tool executions, 0 suspicious content).

## 5. Full-mini Attribution Summary (15 Questions)

| Metric | m13v1 |
|---|---|
| Injection recall | **78.6%** (SH 100% / LME 100% / MH 40%) |
| Final recall | 85.7% |
| Pure retrieval failures | **0** |
| Pure write failures (answer absent from graph) | 1 (weak evidence, unconfirmed) |
| Model side (recalled but answered wrong) | 1 |

## 4. Infrastructure Issues Newly Discovered This Round

- The `wait_queue_drain` 1800s budget was insufficient for the LME context under adjudication overhead (serial extraction ~50min) → aborted. Raised to 7200s (`agent_memoplus_dsh.py`).
- Individual extraction rounds still occasionally produced "extraction produced empty content" (F-1 pattern tail); skipped via bounded retry and no longer blocked the queue.
