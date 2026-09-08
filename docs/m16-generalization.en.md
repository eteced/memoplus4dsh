# M16 — Generalization Validation (All-New Question Set + Cross-Length)

> 中文：[m16-generalization.md](m16-generalization.md)

> Date: 2026-09-08 · Purpose: answer the question "were the previous iterations overfit to a fixed question set?"
> Set: **a second mini set** (`MINI_OFFSET=1` + `MINI_LENGTHS="6k 32k"`) — questions with zero overlap with all 7 prior iteration rounds, plus the 32k tier added back to validate cross-length generalization. tag=m16v1.

## Results

| Tier | Score | Injection recall |
|---|---|---|
| sh_6k | **100%** | 100% |
| sh_32k | 60% | 100% |
| mh_6k | 60% | 100% |
| mh_32k | 60% | 80% |
| LME (judge) | **80%** | multi-session 0.75 (previously the weakest category) |

- **Injection recall across all CR: 95%** (run-2 baseline 7.7%); pure retrieval failures **0**;
- Of the 6 failures, 5 were "injected but the model answered wrong" (model side), 1 did not search — no newly attributable failures on the memory-system side;
- Audits all PASS; zero overlap between the question set and the iteration sets.

## Conclusion

The method **generalizes**: on never-before-seen questions and the 32k length, the memory-system-side recall metrics are on par with or better than the iteration sets (95% vs 88%). All score-side differences are model-side (injected but answered wrong), not memory-recall problems.

Note: LME judge scores are not strictly comparable across question sets (different strides select different questions); CR score fluctuation at n=5 is noise — injection recall and the attribution distribution are more reliable indicators.
