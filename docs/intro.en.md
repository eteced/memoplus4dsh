# memoplus4dsh: Unified Long-Term Memory for deepseek-harness

> 中文：[intro.md](intro.md)

> A dsh plugin: stores everything the agent needs to remember (facts, preferences, schedules, task progress) in **a single entity–time fused memory graph**, replacing the fragmented "one md file per day" style of memory.
> This document: methodological innovations → implementation approach → evaluation results.

## Methodological Innovations

1. **A unified memory graph instead of per-day fragment files.** All memories go into the same graph: entities (persons/objects/concepts) + events (predicate, time, source references); schedules, goals, todos, and conversational facts coexist in one graph. Cross-session inheritance comes naturally — dsh's native goal/todo/schedule state is all per-session, so a new session can't see old progress at all; this plugin fills that gap.
2. **Dual-anchor time semantics (event_time × mention_time).** Distinguishes "when the thing happened" from "when it was mentioned" — asking about "the setback discussed in October" can hit an event that happened in September and was mentioned in October. This mechanism comes from the predecessor memoplus/ETMS and was validated on LoCoMo (82.9% under the mem0 standard protocol).
3. **State-family retrieval dedup (an architectural solution to selective forgetting).** Task-state and fact-update memories keep their full history in the graph (auditable, you can query "when did it change"), but at retrieval time only the latest value of the same state family on the same entity is returned — old states never crowd out injection slots, while history is never lost.
4. **Progress event bridges.** dsh-internal events such as goal/change, todo/write, schedule/change, and plan/mode are projected directly into the memory graph (duck-typed reads, zero upstream dependencies), so long-running task progress can be answered across sessions.
5. **Write-path reliability engineering.** Persistent extraction queue (auto re-extraction after crash/restart), bounded retries with backoff, segmentation of large inputs — plus a pitfall caught in real testing: **reasoning models reason indefinitely on dense extraction inputs until they exhaust their token budget, producing empty visible output** (raising the budget from 8k to 32k doesn't save it). Solution: explicitly disable thinking on extraction/query-expansion calls (the main conversation is unaffected).

## Implementation Approach

```
Each conversation turn ends (turn/end)          User sends a message (agent/pre-step)
        │                                        │
  Async extraction queue (persistent,       Hybrid retrieval: dense cosine + IDF keywords (CJK bigram)
  crash-recoverable)                               + dual-anchor time filtering + one-hop entity expansion
        ▼                                        + MMR dedup + state-family dedup
  LLM extraction (pipe-table format,                │
  thinking disabled)                                ▼
  Entity resolution (name normalization      top-k memories injected as a plugin message
  + alias merging)                           (model-visible ⟺ logged, per dsh's hard constraint)
        │
        ▼
  JSONL memory graph (append-only + periodic snapshots + bad-line tolerance)
  <dsh-home>/memoplus4dsh/
```

- **Form**: official Cordis plugin (npm package), zero patches, install/uninstall scripts fully reversible.
- **Cross-platform**: pure TypeScript + onnxruntime-node prebuilt binaries (Linux/macOS/Windows × x64/arm64); embedding uses a local distiluse multilingual model (character-level tokenization for Chinese + ST projection head restored locally); on failure it degrades to pure keyword retrieval — degraded functionality, not unavailability.
- **Zero new keys**: extraction/expansion reuse the user's already-configured model routing; the embedding model is publicly downloadable (mirror configurable).
- **Proactive tools**: `memory_search` (model actively queries) / `memory_remember` (explicitly stores when the user says "remember…").

## Evaluation Results (MemoryAgentBench, official repo + dataset + metrics, official DeepSeek API)

> Official data loading / templates / metrics / judge reused with zero modifications; the plugin was tested in its default configuration. Full evaluation record (two-round comparison, attribution, engineering metrics): [docs/evaluation.md](docs/evaluation.md); methodology details: [docs/m9-benchmark.md](docs/m9-benchmark.md).
> Numbers below are from the 2026-09-11 full rerun (r2); the previous valid round (r1) in parentheses.

| Dimension | Ours (r2) | Best public baseline |
|---|---|---|
| **Selective forgetting · single-hop** (FC-SH, 6k→262k) | **85.0** (89/78/90/83; r1 57.75) | 60.0 (GPT-4o full text stuffed into the window); best memory-class system 54.0 → **#1 overall, long-context included** |
| **Selective forgetting · multi-hop** (FC-MH) | **51.5** (31/66/55/54; r1 30.25) | **7.0** (everyone) → **7.4× the best baseline** |
| **Accurate recall** (LME(S*), LLM judge) | **68.33** (r1 56.67) | 55.7 (GPT-4.1-mini) → **#1 overall, +12.6 points** |

Two key points:

- **FC-MH is a "death task" where all official agents score ≤7%**; we scored 51.5, still 54.0 at 262k — the only memory system that doesn't collapse on long-context multi-hop forgetting (o4-mini collapses to 14.0 at just 32k). Multi-hop + state updates happen to be exactly the design targets of entity-graph one-hop expansion + state dedup; the r2 multi-hop gains come mainly from system-prompt-guided iterative `memory_search` (attribution: mh_64k injection covers only 22.2%, active search lifts recall to 85.9%).
- The entire evaluation ran under tool-whitelist isolation + per-context auditing — our first-round results were once voided and re-run because the model's "detective mode" peeked at dataset answers; the results above are the clean numbers after hardening (audit details in [docs/m9-benchmark.md](docs/m9-benchmark.md) §0).

Also passed human-scenario tests (cross-session goal progress, todo evolution, SIGKILL crash recovery, etc.); 121 unit tests all green.

**Known weaknesses**: LME multi-session 58.7 (integrating cross-session temporal chains is a structural weakness of retrieval-based memory — still our lowest r2 question type, though up from 42.7 in r1); never-recalled LME questions are mostly write-chain losses (extraction misses), making extraction recall the top next-iteration direction; ingest cost is higher than embed-based approaches (LLM extraction vs vectorization).

## Quick Start

```sh
scripts/install.sh          # install into a dsh profile (default web), fully reversible
scripts/uninstall.sh        # uninstall; memory data is retained in <dsh-home>/memoplus4dsh/
```

See [README.md](README.md) and [docs/install-guide.md](docs/install-guide.md) for details.

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
