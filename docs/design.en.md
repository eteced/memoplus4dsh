# memoplus4dsh Design Document

> 中文：[design.md](design.md)

> Version: v0.1 (implemented)  Date: 2026-09-01
> Status: M1–M5 all complete (skeleton / storage+extraction / retrieval injection / human-scenario testing / release wrap-up).
> Implementation records: docs/m2-notes.md, docs/m3-notes.md, docs/m4-scenario-test.md, docs/m5-release-check.md;
> Known limitations: docs/known-issues.md.

## 1. Positioning and Goals

memoplus4dsh is a **unified memory plugin** for deepseek-harness (dsh): everything the agent needs to remember — schedules, experiences, user knowledge and habits, things that happened in conversation — is stored in **a single entity–time fused memory graph**, replacing the fragmented "one md file per day" style of memory.

Technical origin: the core mechanisms of memoplus/ETMS (Entity–Time fused Memory System) proven effective on LoCoMo (82.9% under the mem0 standard protocol, 81.4% on the temporal category). This project ports its core algorithms into dsh's plugin system.

## 2. Key Decisions

### 2.1 Form: official Cordis plugin, zero patches

dsh's architecture is "everything-is-a-plugin" (the Cordis framework), with a formal plugin mechanism:

- A plugin = an npm package exporting `name` / `inject` / `apply(ctx, config)`; all registration goes through `ctx.effect()` (automatic rollback on unload)
- Official installation: `dsh plugin --profile <name> add <package>`, or add one line to the profile's `cordis.patch.yml`
- The official cookbook's expected form for Memory is exactly "section provider + tool" (`docs/cookbook/extension-cookbook.md`)

**Conclusion: no patch to dsh is needed at all.** The install/uninstall scripts are just wrappers around the official `dsh plugin add/remove` plus default config writing. Guideline 3 (reversible, no direct modification of dsh code) is thereby satisfied naturally.

### 2.2 Language: TypeScript (Node.js), not Python

Guideline 7 (cross-platform: Linux/Windows/macOS, ARM/AMD64) determines this:

- dsh itself is a Node application (`^22.19 || >=24`); JS/TS is the only path for plugins
- memoplus's Python stack (torch/FAISS/HuggingFace) is too heavy a dependency on Windows/ARM, violating the guideline

ETMS's core **algorithms** are reimplemented in TS (all lightweight logic); heavy dependencies get cross-platform substitutes:

| memoplus (Python) | memoplus4dsh (TS) | Rationale |
|---|---|---|
| sentence-transformers MiniLM (torch) | **onnxruntime-node + distiluse-base-multilingual-cased-v2 ONNX** (multilingual by default; optional all-MiniLM-L6-v2 smaller English-only model) | onnxruntime-node ships prebuilt binaries for win/linux/mac × x64/arm64; the model is downloaded to the plugin data directory on first use. Multilingual MiniLM's vocabulary is SentencePiece (which this project's minimal WordPiece tokenizer cannot serve); distiluse is the only multilingual model in its class that retains the mBERT WordPiece vocab.txt. Note that its ONNX export contains only the encoder body (768-dim); ST's 2_Dense projection head (768→512 + Tanh, 1.5MB safetensors) is parsed and applied locally by the plugin — skipping the projection head causes vector semantics to be scrambled (confirmed in M7 testing) |
| FAISS index | **Brute-force cosine (Float32Array)** | At personal-agent memory scale (thousands to tens of thousands of events × 384 dims), brute-force retrieval is millisecond-level; zero native dependencies, runs on any platform. Switch to hnsw if scale ever really grows |
| SQLite event store | **JSONL append + in-memory index + periodic snapshots** | Cross-platform, human-readable and diffable, no compilation needed; consistent with dsh's session log style |
| deepseek-v4-flash extraction | **Reuse the user's already-configured LLM (`ctx.llm.stream`)** | Introduces no new key/endpoint configuration; whatever model the user uses, extraction uses too |

### 2.3 Memory Model (ETMS core port)

One graph, three node types + dual time anchors:

- **Entities**: PERSON / OBJECT / CONCEPT (no more predefined types, to prevent overfitting — a pitfall memoplus already hit)
- **Events**: subject entity + predicate + object + **event_time** (when the thing happened) + **mention_time** (when it was mentioned) + details (additional description) + source (session/turn reference)
- **Dual time anchors** are ETMS's original contribution: asking about "the setback discussed in October" can hit an event that happened in September and was mentioned in October. LoCoMo's 81.4% on the temporal category relies mainly on it.

### 2.4 Write Path (Extraction)

- Trigger: listen for `turn/end` on `session/event`, extract asynchronously in batches (does not block conversation)
- Extraction prompt: port memoplus's pipe-table format (entity|predicate|object|time|details), including proven rules such as pronoun/coreference resolution and image-caption ingestion
- Robustness (ported from memoplus pitfalls): bounded retries on LLM calls + skip-and-record on failure; known_entities filtered by relevance to the current text (prevents unbounded prompt bloat)
- Unified memory: dsh-internal events such as schedules (schedule/change), goals (goal/change), and todos (todo/write) are also bridged into memory events — schedules, experiences, and preferences all live in the same graph

### 2.5 Retrieval Path (Injection)

- Stable section: `ctx.systemPrompt.section()` registers a Memory section (brief usage instructions; no volatile content, does not break prompt caching)
- Dynamic injection: `agent/pre-step` waterfall, retrieves top-k against the current user message, injected as `user/message` (`source: {kind:'plugin', plugin:'memoplus4dsh'}`) — satisfying dsh's hard constraint of "model-visible ⟺ logged"
- Ranking: dense cosine + IDF term matching (with stemming) + time-range filtering (dual anchors) + one-hop entity expansion + MMR diversity dedup
- Proactive tools: `memory_search` (model actively queries) + `memory_remember` (model actively stores — when the user explicitly says "remember...")

### 2.6 Privacy and Configuration

- All data stored in `$DSH_HOME/memoplus4dsh/` (follows dsh home, user-controllable and deletable)
- Zero new keys: the LLM goes through dsh's credentials seam; the embedding model is downloaded from a public HuggingFace address (mirror configurable)
- Public-repo constraint: `.gitignore` covers the data directory / model cache / any credentials; no API key appears anywhere in the repo

## 3. Project Structure

```
memoplus4dsh/
├── package.json            # npm package: memoplus4dsh, Cordis plugin entry
├── tsconfig.json
├── src/
│   ├── index.ts            # plugin entry: name/inject/apply + Config interface, assembles the modules
│   ├── store.ts            # memory graph storage: JSONL append + in-memory index + snapshots
│   ├── extraction.ts       # turn/end async extraction (LLM prompt + pipe parsing)
│   ├── embedding.ts        # onnxruntime-node MiniLM; falls back to pure keyword on failure
│   ├── retrieval.ts        # hybrid scoring + dual-anchor time filtering + entity expansion + MMR
│   ├── temporal.ts         # temporal expression parsing (relative time / last year / recently etc.)
│   ├── inject.ts           # systemPrompt section + agent/pre-step dynamic injection
│   ├── tools.ts            # memory_search / memory_remember tools
│   └── bridges.ts          # bridge goal/todo/schedule/plan progress events into the memory graph (M8)
├── scripts/
│   ├── install.sh / uninstall.sh    # dsh plugin add wrapper + default config (bash, Linux/macOS)
│   └── test-harness/       # local test dsh instance management (see §4)
├── tests/                  # vitest unit tests
├── docs/                   # this file + milestone records + test reports
├── README.md
├── LICENSE.md              # existing (Modified MIT)
└── .gitignore
```

## 4. Test Plan (Guideline 5)

### 4.1 Local Test Instance (scripts/test-harness/)

- `start-test.sh`: launches dsh web with an isolated `DSH_HOME=<workspace>/test/dsh-home`, working directory locked to `<workspace>/test`, bound to 127.0.0.1 on a random port
- **Hard permission limits**: the `cordis.patch.yml` of both the web and sdk profiles has a fixed sandbox-policy block written in (`mode: workspace-write` + explicit `workspaceRoot` = test directory, marker-managed and idempotent); the sdk-driver also strips `DSH_PERMISSION_MODE` from the subprocess environment at startup, preventing environment variables from escalating the permission mode. File writes are intercepted by fs-sandbox; processes are confined by bwrap/Landlock to workspace + /tmp
- **Access control**: dsh web's built-in launch token authentication (32-byte random, URL carries `?token=`) + HMAC cookie; the authenticated URL is scraped from the log by the start script and stored in `<test-dir>/run/web.url` (gitignored), loopback-only binding
- `stop-test.sh` / `reset-test.sh`: stop processes (PID identity verified before kill) + delete the test DSH_HOME and test data (with path sanity checks), resettable at any time

### 4.2 Automated Tests

- vitest unit tests: store / temporal / retrieval scoring / pipe parsing / embedding fallback
- Integration tests: reuse dsh `test-support/llm-replay`'s MockAdapter, runnable without any API
- Scenario tests (simulating real human use): scripted multi-turn conversations → shut down the instance → come back "the next day" and ask "what was the XX I mentioned last time", "remind me of my Friday schedule", "what do I like" → assert that memories are correctly retrieved and injected

## 5. Milestones

1. **M1 mountable skeleton**: empty plugin loads in dsh (`dsh plugin add` succeeds, web starts without crashing), install/uninstall/reset scripts work
2. **M2 storage + extraction**: turn/end extraction writes to the JSONL graph, covered by unit tests
3. **M3 retrieval injection**: pre-step injection + memory_search tool, MockAdapter integration tests
4. **M4 human-scenario testing**: simulate real usage in the test instance, verify "cross-day memory", "preference learning", "schedule-reminder association" scenarios
5. **M5 documentation wrap-up**: README / install docs / uninstall rollback verification, commit and notify for deployment

## 6. Risks and Notes

- onnxruntime-node's Windows ARM64 prebuilt support needs verification; on failure, fall back to pure keyword retrieval (degraded functionality, not unavailability)
- `ctx.llm.stream()` extraction consumes the user's API quota — an `extraction: off|turn_end|session_end` config option is provided by default
- dsh is 0.1.2-alpha (officially declared to have breaking changes); the plugin API surface (Cordis services/events) is relatively stable, but regression testing is needed when upgrading dsh
