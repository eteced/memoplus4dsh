# M8 — Loss Risk of Critical Memory (Task Progress): Systematic Evaluation and Improvement Plan

> 中文：[m8-progress-memory-eval.md](m8-progress-memory-eval.md)

> Date: 2026-09-01 Status: **implemented and verified** (scenario tests S1-S4 PASS; worked throughout the M9 benchmark second round)
> Scope: the most core promise of an agent memory plugin is "don't lose critical memories". This document systematically evaluates the loss risk of **task progress** (especially for long-running tasks) across the entire memoplus4dsh pipeline (write → store → retrieve → inject), and proposes improvements.
> Method: code walkthrough of this repository + investigation of the dsh upstream event surface (packages/goal, todo, schedule, plan, core/session, compaction); all conclusions come with file:line evidence.

## 1. dsh-Side Fact Sheet (where progress state lives and how it flows)

1. **goal/todo/schedule/plan are all per-session event-log state, with no native inheritance across sessions**.
   - goal: `goal/change` events carry a full snapshot `{ objective, phase: active|paused|blocked|complete, blockedReason?, revision, maxGoalRounds }` (`deepseek-harness/packages/goal/goal/src/types.ts:59-68`); rounds are derived by replaying `user/message` events with `source.kind === 'goal'` (`goal/src/fold.ts:321-331`). The module describes itself as a "same-session goal domain" (`goal/src/index.ts:1-4`).
   - todo: `todo/write` events carry a full list snapshot `{ content, status }[]` (`todo/tool-todo/src/types.ts:21-33`), per-session, and it is "log-only UI state, never derived history" — **the model cannot see todo state in derived history**.
   - schedule: `schedule/change` versioned stream (create/delete/dispatch) (`schedule/schedule/src/types.ts:213-221`), session-local.
   - plan: `plan/mode { active }` (`plan/plan-mode/src/index.ts:39-48`).
2. **All these events go through the `session/event` bus** and are observable by plugins (`core/session/src/index.ts:74`; each package declares its types via SessionEventMap declaration merging).
3. **dsh itself does not inject progress state into the system prompt** (tool-goal has only a static rules section, `tool-goal/src/index.ts:188-192`); goal round advancement relies on the goal-round-driver injecting `<goal_round>` user messages (`goal/goal-round-driver/src/prompt.ts:12-25`), and the model must actively call `get_goal` to read precise state.
4. **Cross-session recovery is a blank spot in dsh**: a new session cannot see the old session's goal/todo/schedule (only the optional session-query tool can manually search old logs) — this is exactly the value point of this plugin.
5. **Compaction does not lose progress state** (log-only events are never shadowed, `core/session/src/types.ts:384-389`), but narrative content visible to the model (including tool results with todos) may be compacted; dsh compensates via summary templates (`compaction-basic/src/summarizer.ts:36-55`).

## 2. Loss-Point Inventory (sorted by severity)

### L1 [critical] Progress-event bridging completely unimplemented: goal/todo/schedule/plan changes never enter the memory graph

`src/bridges.ts` is an empty shell (`registerBridges` returns `[]`). Consequences:

- When a user runs a long task in goal mode, phase changes (active→blocked→complete), blockedReason, and the objective text **never enter the memory graph**.
- The todo list (task breakdown and per-item completion status) is **completely invisible** — yet it is precisely the most structured carrier of task progress in dsh.
- Scheduled-task creation/triggering/deletion never enters memory.
- In cross-session scenarios (dsh's native blank spot, see §1.4): when a new session asks "how far did I get on that task", the memory graph contains no stateful answer — only stray fragments the assistant happened to say in conversation.

### L2 [major] Extraction input filters out goal-round and schedule reminder messages

`buildTurnText` at `src/index.ts:93` only accepts user/message with `source.kind === 'user'`. Whereas:

- Goal round prompts have `source: { kind: 'goal', goalId, revision, round }` (containing the full objective text + Round n/max) — filtered out. The assistant's round replies do enter extraction, but lack the context of "which round this is and what the goal is", degrading pronoun/coreference resolution quality.
- Schedule trigger reminders have `source: { kind: 'plugin', plugin: 'schedule' }` — filtered out. Schedule reminder facts are lost.

### L3 [major] Retrieval has no recency signal: stale progress competes on equal footing with new progress

In DENSE mode (queries without time words, the vast majority), `temporalBonus` is always 0 (`src/temporal.ts:417`). For a query like "how is the task progressing", "the project just started" from three weeks ago and "80% complete" from yesterday compete for topK seats with the same score. The M6 report already listed this as a candidate improvement; this document upgrades it to a formal fix item for the progress scenario.

### L4 [major] "Latest"-type Chinese queries have no temporal operator

`resolveTemporalQuery`'s Chinese rules only cover 去年/今年/最近/近期/昨天 (last year/this year/recently/lately/yesterday) (`src/temporal.ts:313-319`). "最新进展" (latest progress) and "最近一次做到哪" (where did I get to last time) are the highest-frequency phrasings in progress scenarios, and all of them fall into DENSE (compounding L3).

### L5 [major] No supersede/invalidation semantics: state-evolution sequences coexist with equal weight

The memory graph is append-only: "task in progress (step 2)", "task in progress (step 7)", and "task complete" coexist permanently with equal weight. The graph itself should not delete (history is auditable, one can ask "when was it completed"), but **the retrieval/injection layer needs to prefer the latest state**, otherwise topK seats get crowded out by stale states.

### L6 [major] Turns whose extraction failed are never re-extracted

After `ExtractionQueue` retries are exhausted, the turn is skipped, and it is not retried even after a process restart (already stated in known-issues). If the failure happens to occur on the "task complete" turn, critical progress is permanently lost. The root cause is that queue state is not persisted.

### L7 [minor] turnText 20k truncation may drop mid-section progress

The head-and-tail-preserving truncation introduced in M6 (`src/extraction.ts` MAX_TURN_TEXT_CHARS). The middle of a long work-log turn may be discarded. Head-and-tail preservation is already the optimal trade-off; recorded, no change.

### L8 [minor] memory_remember writes have no entity anchor

`memory_remember` does not write entities (`src/tools.ts`), so pure entity-anchor retrieval can't find them. When a user explicitly says "remember: task X has completed step 3", that memory can only be hit via dense/keyword.

### L9 [record] dsh compaction is an opportunity, not a risk, for this plugin

After dsh compaction the model can't see todo tool results (§1.5), while our memory injection can still supply progress facts after compaction — the evaluation confirms no change is needed, but scenario tests should cover "asking about progress after compaction".

## 3. Improvement Plan

### P0-A Progress-Event Bridge (implement bridges.ts, fixes L1)

Listen to `session/event` and project four kinds of progress events into memory events (`sourceTurn = -1`, `sourceSession = session.id`, mentionTime taken from the event time; entities anchored to CONCEPT-type task entities):

| dsh event | Projection rule | Denoising |
|---|---|---|
| `goal/change` | One event per change: predicate=`goal_<phase>`, normalizedText like "Goal 'X' entered blocked state: reason"; objective summary goes into details | revision is monotonic, record all (phase changes are critical memories) |
| `todo/write` | Full snapshot summarized into one event: "Todo list: 3/7 done; in progress: X; next: Y" | Skip if identical to the previous snapshot (todo_write is high-frequency) |
| `schedule/change` | One event each for create/delete/dispatch ("Created a reminder for every Friday 17:00: X", "Reminder triggered: X") | dispatch recorded separately from create; triggering is also a fact |
| `plan/mode` | One event each for entering/exiting plan mode | Only changes are written (the event itself is a change) |

Events are tagged with `predicate` prefix families (`goal_*`/`todo_snapshot`/`schedule_*`/`plan_mode`) for the state dedup in P1-C.

### P0-B Include goal-round and schedule messages in extraction input (fixes L2)

Extend `buildTurnText`: include user/messages with `source.kind === 'goal'` (tagged with a `Goal:` prefix) and `source.kind === 'plugin' && source.plugin === 'schedule'` (tagged with a `Schedule:` prefix). Continue to exclude this plugin's own injections (`plugin === 'memoplus4dsh'`, to prevent feedback loops) and runtime-context snapshots.

### P1-A Recency term in DENSE mode (fixes L3)

Make `temporalBonus` effective in DENSE too: `0.3 / (1 + daysSinceMention / 30)` (mention anchor, magnitude capped at 0.3 ≤ entityBonus 0.5). Pure ranking signal, no filtering. New events stably get a small advantage; old facts are not buried (a 0.3 magnitude cannot overpower the 2.0 keyword channel).

### P1-B Chinese "latest"-query operator (fixes L4)

Add to `resolveTemporalQuery`: `最新`/`最近一次`/`上次` (latest/most recent/last time) — when not part of ambiguous phrases like "上次说" (last time said) — → `LAST_K k=1`. Only add high-confidence words; "目前/现在" (currently/now) are not added (bare words are too ambiguous — repeating the M6 "this" lesson).

### P1-C Retrieval dedup of state-type events (fixes L5)

For the predicate families tagged by P0-A (goal/todo/schedule/plan state events), in retrieval results keep only the one with the latest mentionTime per `(subjectEntity, predicate)`. Historical events remain in the graph; `memory_search` queries with time words ("when was it blocked") can still hit history via time filtering. Implementation location: in `Retriever.retrieve`, after final ranking and before topK truncation.

### P2 Extraction queue persistence (fixes L6)

`dataDir/extraction-pending.jsonl`: write to disk first (append) on enqueue, write a corresponding tombstone line after job success/skip; on plugin startup, scan this file and re-enqueue jobs without tombstones (route is persisted along; if route is missing after restart, use the current lastRoute or wait for the first session). The file can be truncated and rewritten once all jobs have tombstones. This way, failed turns can be re-extracted after a process crash/restart. Combined with the existing idempotent writes (events are appended by content; the cost of duplicate extraction is duplicate lines, not corruption — acceptable, see below) — to prevent duplicate-extraction bloat, before requeueing check whether `extraction-debug.jsonl` recently has an `extracted` record for that (session,turn); if so, treat it as completed.

### Configuration Items (defaults carefully considered)

| New config | Default | Description |
|---|---|---|
| `progressBridge` | `true` | P0-A master switch |
| `stateDedup` | `true` | P1-C state dedup switch |
| (no new config) | — | P1-A recency magnitude is small and purely beneficial; P0-B/P1-B/P2 are correctness fixes and get no switches |

## 4. Acceptance Criteria

1. Unit tests: bridge projection (four event kinds → correct memory events + todo denoising), buildTurnText new-source inclusion/self-plugin exclusion, DENSE recency magnitude, "最新"→LAST_K, state dedup keeps only the latest, pending queue crash recovery (requeue after kill + restart).
2. Scenario verification (local test instance + real LLM): run 3 rounds in goal mode → new session asks "how is my task progressing" → injection contains the latest goal state rather than a stale round; todo_write twice → "what do I still have left to do" hits the latest snapshot; kill the instance and restart → failed turns are re-extracted.
3. Regression: existing 101 unit tests all green; injection size does not exceed injectMaxChars.

## 5. Implementation Record

Implemented on 2026-09-01, all plan items landed; commits at the end of this section.

**Changed files**:

- `src/bridges.ts` (rewritten): P0-A progress-event bridge. `registerProgressBridge` listens to `session/event` and reads the goal/change, todo/write, schedule/change, plan/mode payloads structurally (duck typing) — the plugin does not depend on dsh's goal/todo/schedule/plan packages, so upstream type changes degrade to skipping events rather than compile errors. Todo snapshots are denoised by content signature; schedule delete/dispatch use an in-session id→prompt map to fill in the reminder text. The state predicate families (`goal_*`/`todo_snapshot`/`schedule_*`/`plan_mode`) are exported as `statePredicateFamily` for retrieval dedup.
- `src/index.ts`: P0-B `buildTurnText` now includes `source.kind === 'goal'` (Goal: prefix) and `source.plugin === 'schedule'` (Schedule: prefix) messages; this plugin's injections and runtime-context snapshots remain excluded; P2 wires in `PendingJobLog` (enqueue writes to disk, success/skip writes tombstones, startup requeues jobs without tombstones); new configs `progressBridge`, `stateDedup`.
- `src/temporal.ts`: P1-A DENSE-mode mention recency term (`0.3/(1+days/30)`, capped below entityBonus); P1-B `最新/最近一次/上次` → `LAST_K k=1` (checked before "最近" due to substring containment).
- `src/retrieval.ts`: P1-C `dedupStateEvents` — per (subject entity, state family) keeps only the event with the latest mentionTime (ISO string lexicographic order is chronological order), applied before MMR/topK truncation; `RetrieverOptions.stateDedup` defaults to true.
- `src/extraction.ts`: `PendingJobLog` (JSONL pending/tombstone log, tolerant of a torn trailing line after a crash, truncated after load). Deviation from the plan: the "check extraction-debug.jsonl before requeue to prevent duplicates" step was not implemented — the tombstone is written synchronously after `extractTurn` returns, the crash window is extremely small, and the duplicate cost is only one LLM call + duplicate lines (no data corruption), so the simplification holds.

**Tests**: 10 test files, 119 unit tests all green (18 new: bridge projection/denoising/fault-tolerance 9, buildTurnText source admission 2, PendingJobLog crash recovery 3, DENSE recency 1, "最新" operator 1, state dedup 2).

**Scenario verification (real LLM, OpenCode Zen endpoint, `scripts/test-harness/run-m8-scenarios.mjs`)**:

- Endpoint limitation and workaround: Zen's streaming tool_calls explicit-null override bug (known-issues F1) still exists; with a direct connection all tool calls fail. For this, a **test-only** `zen-nullstrip-proxy.mjs` was written (loopback listener, only deletes explicit null keys in SSE chunks, forwards everything else verbatim) to bypass it.
- **S1 goal progress cross-session PASS** (after fix): create_goal → block, new session asks "latest progress" — the injection is exactly the latest state "blocked: waiting for review test report", without the stale "goal created" (state dedup in effect); the model's reply explicitly noted that `get_goal` returns empty in the new session and the answer came from long-term memory — hard proof that the plugin fills the cross-session blank.
- **S2 todo snapshot evolution PASS**: two todo_writes → new session asks "what's left undone", the injection is the latest snapshot (1/3 done), and the reply correctly lists unfinished items.
- **S3 conversational state evolution PASS** (no tools, P1 retrieval side): first says "just started, writing the first page" then "80% done, only deployment left", new session asks "latest progress" — the reply hits 80%/deployment and is not dominated by the stale state (LAST_K + recency).
- **S4 crash recovery PASS**: send facts in a row then SIGKILL without graceful shutdown (3 pending lines backlogged before the kill); after restarting with the same DSH_HOME, all facts (小白/雪球/墨墨) were re-extracted.
- **Bug exposed by S1's first-run FAIL and its fix**: the bridge read the goal/change payload as a flat structure, while dsh's actual payload is nested (`data.goal.objective`, see real session logs) — renderGoalChange silently returned null and all goal events were lost. Fixed by unwrapping `data.goal ?? data` (flat-compatible); unit tests switched to the real payload shape. **Lesson: duck-typing contracts must be verified against real logs, not imagined from reading upstream type definitions.**

**commit**: see git log (M8 implementation + M8 scenario fixes).
