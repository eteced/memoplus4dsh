# M6 — Third-Party-Perspective Testing and Review Report

> 中文：[m6-third-party-review.md](m6-third-party-review.md)

> Date: 2026-09-01 Baseline: v0.1 (after M5 release, `51873e7`)
> Method: three independent review passes from the perspective of "a reviewer encountering this project for the first time" (code correctness / default parameters / install scripts and release hygiene); all conclusions verified against the source code and the dsh upstream API; obvious issues were then fixed and regression tests added.

## 1. Baseline Verification

- `npm run build` (tsc): passes.
- `npx vitest run`: 8 test files, 92 unit tests all green (96 after fixes, including 4 new regression tests).
- No real-LLM scenario tests run this round (covered by M4, see docs/m4-scenario-test.md); this round was static review + unit tests.

## 2. Code Correctness Review: Findings and Fixes

### Fixed (each with regression tests or verification)

| # | Severity | Issue | Fix |
|---|---|---|---|
| M1 | major | Bare "this"/"past" (no unit) was misjudged as a 180-day time hard filter — a high-frequency query like "how do I fix this error?" would silently filter out all old memories (`temporal.ts` ORDINAL_RE) | Unit-less this/past no longer produces a time operator; new case in `tests/temporal.test.ts` |
| M2 | major | Conversation-locality boost was dead code: the anchor key used `split('')` to split character by character, session comparison always failed, and the entire turn-locality weighting never took effect (`retrieval.ts`) | Key changed to a `sess\|turn` separator and parsed correctly; new "same-turn events rank higher" case in `tests/retrieval.test.ts` |
| M3 | major | Chinese "上周X" (last-week-X) was off by 7 days when the target weekday had already passed (e.g., saying "last Wednesday" on a Friday returned this Wednesday); the wrong eventTime would be persisted (`temporal.ts`) | `上` alone now uses the `currentWd + 7 - wd` formula; 3 new cases in `tests/temporal-zh.test.ts` |
| m1 | minor | Prompt templates used `String.replace` to interpolate user text; patterns like `$&`/`$\`` would pollute the prompt (in two places: extraction/retrieval) | Switched to the replacement-function form |
| m2 | minor | Extraction retries had no backoff: timeout-type failures retried immediately as-is, blocking the queue with 3×120s and burning 3× tokens | ExtractionQueue gains `retryDelayMs` (default 5s/30s), injectable |
| m3 | minor | turnText entered the extraction prompt without a limit: a user pasting a large log → single-turn cost out of control | `MAX_TURN_TEXT_CHARS = 20000`, truncated keeping head and tail |
| m4 | minor | dispose did not drain the extraction queue; graceful shutdown lost pending jobs; on hot reload the old queue could also append after the new instance's snapshot | disposer changed to async, `await queue.whenIdle()` before `store.close()` |
| m5 | minor | `memory_remember` had no parameter validation; empty/whitespace-only facts were stored as-is | trim + non-empty validation, throws on empty |
| m6 | minor | The LAST_K time bonus only looked at eventTime; events without eventTime (the majority) got no recency boost under "the last time we spoke", inconsistent with the dual-anchor design | Fallback to mentionTime; new regression test added |
| m7 | minor | BERT basic tokenizer does not split CJK: a whole Chinese passage collapses into a single [UNK], dense signal entirely wasted | `basicTokens` now splits CJK character by character (standard BERT behavior) |
| m8 | nit | Config comment "default 240s" inconsistent with code's 120s; `injectTopK` had dual defaults (required field + Retriever hiding 10) | Comment aligned to 120s (M4 measured value); `injectTopK` made optional with code default 8 |

### Not Fixed (recorded, with reasons)

- **Multiple instances sharing a dataDir overwrite each other's snapshots** (major): when two dsh processes share the same DSH_HOME, the later snapshotter overwrites the other's increments. The fix (lock file/merge) is costly, and this deployment shape is misuse — the single-instance assumption has been written into known-issues.
- **Embedding initialization failure cached until restart**: after the first download failure, the process does not retry. Minor impact (recovers on restart); written into known-issues.
- **Query-expansion cache read-modify-write race**: concurrent pre-steps may lose cache entries; only hit rate is lost.
- **`ensureEmbeddings` duplicate concurrent embeds**: wastes one inference; data is idempotent.
- **Injection still appends a memory message when upstream empties messages**: rare upstream combination; behavior debatable.
- **extraction-debug.jsonl does not rotate**: written into known-issues; users can clean it up themselves.
- **Setting only one of `extractionProvider`/`extractionModel` is silently ignored**: a config footgun, left as a future improvement.
- **ISO dates not range-validated** (2023-13-40 rolls over), aliasIndex squatting, snapshot tmp residue not cleaned: all nits.

## 3. Default Parameter Review: Conclusions and Adjustments

Review criteria: ordinary users don't change configuration, the default model may be a reasoning model (thinking burns tokens), extra latency and cost per conversation turn.

### Defaults Adjusted This Round

| Parameter | Old default | New default | Reason |
|---|---|---|---|
| query expansion samples | 2 | **1** | The second sample only buys marginal recall while latency/cost doubles directly; this call is on the pre-step critical path |
| query expansion maxTokens | 4096 (hardcoded) | **1024** | Output is ≤12 lines of keywords; 1024 is enough to cover a reasoning model's thinking |
| query expansion timeout | followed extraction's 120s | **independent 30s** | When the endpoint misbehaves the user waits at most 30s extra instead of 4 minutes (2×120s); on failure it naturally degrades to no expansion |
| extraction retry backoff | none (immediate) | **5s / 30s** | Immediate retry basically replays the same failure |
| extraction input limit | none | **20000 characters** (head and tail kept) | Closes the only opening for single-turn cost blowout |

### Defaults Kept After Review (with reasons)

- `extraction: turn_end`, `injection/tools/embedding/queryExpansion: true`: core selling points, all with degradation paths on failure.
- `injectTopK 8` × `injectMaxChars 2000`: injects roughly 0.6–1.6k characters; the squeeze on main context is acceptable.
- `extractionMaxTokens 8192` + `extractionCallTimeoutMs 120s`: validated by M4 real measurements (including reasoning endpoints); the cap costs nothing for non-reasoning models. The comment once said 240s; aligned to the code.
- `snapshotThreshold 1000`: compresses about once per 60–70 conversation turns; crash window ≈ 0 (append is synchronously atomic).
- Retrieval scoring weights (dense×1 + keyword×2 + entity 0.5 + expansion ≤2.0 + MMR 3.0): magnitudes are self-consistent; in Chinese scenarios the keyword-dominant profile happens to compensate for MiniLM's CJK weakness.

### Default Candidates Left for Future Versions

- **Add recency decay to DENSE mode**: currently a query with no time intent completely ignores recency — "lived in Beijing last year" and "moved to Shanghai last month" score the same. The change affects ranking quality and needs scenario evaluation before tuning; untouched this round.
- **Multilingual embedding model**: ~~recommended as an optional config item in the next version~~ already landed in M7 — default switched to distiluse-base-multilingual-cased-v2 (512 dimensions, WordPiece vocabulary compatible with the existing tokenizer; multilingual MiniLM was excluded due to its SentencePiece vocabulary), `embeddingModel: 'english'` keeps the pure-English small-model option, and old vectors are automatically migrated and recomputed by dimension.

## 4. Install Scripts and Release Hygiene: Findings and Fixes

### Fixed

| # | Severity | Issue | Fix |
|---|---|---|---|
| B4 | medium (security) | The sdk profile had no pinned sandbox-policy, and sdk-driver passed through `DSH_PERMISSION_MODE` — an environment variable could elevate the test instance's permissions to fully unrestricted | The sdk profile now also pins `workspace-write`+workspaceRoot (idempotent marker block, re-stamped before launch); the child process env explicitly strips `DSH_PERMISSION_MODE` |
| A3 | medium | `mktemp` templates had a suffix after the X string; macOS (BSD mktemp) fails outright | Three templates changed to suffix-free form, verified by real runs |
| A2 | medium | python3 is a hard dependency but scripts didn't check it and docs didn't declare it | install/uninstall check at the start and report a friendly error; install-guide prerequisites updated |
| C2 | medium | package.json `"license": "MIT"` inconsistent with LICENSE.md (Modified MIT, with an attribution addendum) | Changed to `SEE LICENSE IN LICENSE.md` |
| C3 | medium | design.md contradicted the code in multiple places (nonexistent config.ts / install.ps1 / wrong test paths / unimplemented guard plugin / wrong token description) | §3/§4 entirely rewritten to reflect the actual implementation |
| C4 | medium | Windows users had no install path (only .sh), conflicting with the cross-platform guideline statement | README/install-guide clarified: scripts support Linux/macOS + manual Windows install steps (the plugin runtime itself is cross-platform) |
| B2 | low-medium | Two dead .gitignore entries (paths didn't match); test token files unprotected | Changed to `test/`, `**/dsh-home/`, `**/run/web.url`, verified with `git check-ignore` |
| A5 | low | uninstall silently left file: dependencies behind when npm was missing | That branch now prints a prominent WARNING |
| B5 | low | reset-test.sh's `MEMOPLUS4DSH_TEST_DIR` had no guard rails | Rejects empty values / `/` / paths not containing test |
| B6 | low | stop-test.sh had no PID identity check; PID reuse could kill the wrong process | Verifies cmdline contains dsh before kill; stale pid files cleaned up safely |

### Not Fixed (needs user decision)

- **C1 A launch token remains in git history** (introduced in `e2a4d51`; `51873e7` only changed the current file): it is actually the token of a long-dead local temporary test instance, extremely low risk; but after public release anyone can retrieve it from history. Options: (a) `git filter-repo` to rewrite history (destructive, requires force-push); (b) note it honestly in the release notes. **Recommend (b)**; if (a) is desired, please say so before release.
- **A1 uninstall does not fully reverse "profiles newly created by the script"**: pre-existing profiles are fully restored; the empty profile skeleton initialized by the script is kept. Behavior is safe; documentation wording verified (README's "dsh runs exactly as before" holds for pre-existing profiles).
- **B3 The `tools/pre-execute` guard plugin (belt-and-suspenders) originally promised in design.md was not implemented**: the single-layer sandbox-policy pin already satisfies guideline 5a's hard restriction requirement (fs-sandbox + bwrap/Landlock, and the environment-variable privilege-escalation path is blocked); the guard plugin is recorded as optional hardening, and design.md has been updated to describe reality.

## 5. Test Conclusions

- After fixes, `npm run build` + `npx vitest run`: **8 files / 96 unit tests all green** (4 new regression tests covering M1/M2/M3/m6).
- Script fixes all verified by real runs (bash -n, real mktemp execution, _patch_yml idempotency, check-ignore, reset/stop guard rails and wrong-kill protection, uninstall degraded branch).
- All three major retrieval/temporal bugs were of the "tests happened not to cover this" type; regression tests have been added for all of them this round.
- Defaults reviewed item by item: 5 tightened (3 in the query expansion chain + extraction backoff + input limit), the rest kept with justification.
- **Recommended focus areas after deployment**: Chinese retrieval quality (bigram fallback vs weak dense), whether the 120s extraction timeout is sufficient under reasoning-model endpoints (directly observable via extraction-debug.jsonl), subjective feel of injection size.
