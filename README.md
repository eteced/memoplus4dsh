# memoplus4dsh

> 中文：[README.zh.md](README.zh.md)

Unified long-term memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

One coherent entity-time fused memory graph for everything an agent needs to remember — facts, preferences, plans, and events from conversations — instead of scattered per-day markdown files. The core algorithms are ported from the memoplus/ETMS research codebase, validated on LoCoMo (82.9% under the mem0 protocol).

**Status: v0.1 implemented.** Tech report: [docs/tech-report.md](docs/tech-report.en.md). Intro (method + benchmark results): [docs/intro.md](docs/intro.en.md). Evaluation record: [docs/evaluation.md](docs/evaluation.en.md). Changelog: [CHANGELOG.md](CHANGELOG.md). Architecture: [docs/design.md](docs/design.en.md). Known issues: [docs/known-issues.md](docs/known-issues.en.md).

## Vision

> **One agent, one whole memory — undivided, unbroken, as memory was meant to be.**
> **一个 Agent，一整份记忆——不拆散，不分割，如人的记忆一般完整连续。**

memoplus4dsh is the unified long-term memory plugin for deepseek-harness. Everything your agent needs to remember — facts, preferences, schedules, task progress — lives in a single entity–time-fused memory graph. No per-day markdown shards, no forgetting between sessions. One memory, for the whole life of the agent.

memoplus4dsh 是 deepseek-harness 的统一长期记忆插件。它把 agent 需要记住的一切——事实、偏好、日程、任务进度——存进同一张实体-时间融合的记忆图：没有按日拆散的 md 碎片，没有跨会话的遗忘。一份记忆，伴随 agent 的全部生命。

We believe an agent's memory should work like a human's: whole, continuous, and growing. Not diary pages piling up in a filesystem, not a scratchpad wiped clean at every session's end — but one unbroken memory, written from day one to today. An agent that remembers yesterday, and last year; that knows where the task stands, and recalls the preference you mentioned in passing. When memory becomes whole, an agent truly begins to *know* you. We hope memoplus4dsh is a cornerstone on that path: simple, open, and verifiable — doing one thing well: one whole memory.

我们相信，agent 的记忆应该像人的记忆一样：一体、连续、会生长。不是文件系统里越积越多的日记页，不是每次会话结束就归零的暂存——而是一份从第一天写到今天的、完整的记忆。今天的 agent 记得昨天，也记得去年；它知道任务进行到了哪一步，也记得你无意中提起的喜好。当记忆成为一体，agent 才真正开始"认识"你。我们希望 memoplus4dsh 是这条路上的一块基石：简单、开放、可被检验——先把"一份完整的记忆"这一件事做好。

## How it works

```
conversation turn ends (turn/end, completed)
        │
        ▼  async serial queue, bounded retries, never blocks the chat
  LLM extraction (pipe-table prompt: entities | predicate | object | time | fact | details)
        │
        ▼  entity resolution (name normalization + alias merge) into the memory graph
  JSONL journal at <dsh-home>/memoplus4dsh/  (append-only, snapshot compaction,
        │                                    corrupt-line tolerant, dual time anchors:
        │                                    event_time + mention_time)
        ▼
next user message (agent/pre-step) ──► hybrid retrieval (dense cosine + IDF keywords
        │                              + temporal dual-anchor + one-hop entity expansion
        │                              + MMR diversity; LLM query expansion, disk-cached)
        ▼
top-k memories injected as a plugin-sourced user/message (logged like any model input)
```

Four model-facing tools are also registered: `memory_search` (active recall), `memory_remember` (explicit "remember this"), `memory_visualize` (renders the memory graph as a self-contained interactive HTML page at `<dataDir>/memory-graph.html`; also available offline via `node scripts/visualize.mjs`) and `memory_status` (live report: effective config, active embedding/NER backends, graph size, extraction queue health — ask the agent "memory status" in chat). Extraction reuses the session's own provider/model route — no new API keys.

## Requirements

- dsh `≥ 0.1.2-alpha.3` (verified up to 0.1.5-alpha.2; dsh is pre-release and may break compat)
- Node `^22.19 || >=24` and `python3` (used by the install scripts to edit `cordis.patch.yml`)
- Linux or macOS for the install/uninstall scripts (bash). On Windows the plugin itself runs fine — install manually: `npm install <this dir>` in the profile directory and add the plugin block to the profile's `cordis.patch.yml` as shown in [docs/install-guide.md](docs/install-guide.en.md)
- Optional: `onnxruntime-node` (declared as an optional dependency) for local embeddings; without it retrieval degrades to keyword-only, nothing breaks
- Optional boost (recommended — this is the full-featured setup): `sentence-transformers` (harrier embedding backend, better retrieval) and `torch gliner stanza` (NER candidate hints, better extraction recall) in the `python3` environment. Everything still works without them — it just degrades to ONNX embeddings + no NER hints; one-command install: `scripts/setup-python.sh`

## Install

```sh
# from this repository; --profile defaults to web, --dsh-home to $DSH_HOME or ~/.dsh
scripts/install.sh [--profile <name>] [--dsh-home <path>]
```

The script builds the plugin, links it into the profile (`npm install <this dir>`), and mounts it via a managed block in the profile's `cordis.patch.yml`. **First run downloads models lazily** (ONNX embedding ~135MB; harrier ~1.2GB and GLiNER ~600MB only when their python packages are present) — the first few conversations are slower, then everything is served from local cache. Set `hfBaseUrl` to a mirror if huggingface.co is slow. No dsh source is ever modified. See [docs/install-guide.md](docs/install-guide.en.md) (中文) for a full walkthrough including verification.

## Update

```sh
git pull && npm run build
```

No reinstall needed: the profile links this checkout via a `file:` dependency, so rebuilding `lib/` is the whole update — then **restart dsh** to pick it up. (dsh's live reload is config-only: edits to `cordis.patch.yml` apply without a restart, plugin code does not.) Rerun `scripts/install.sh` (idempotent, also builds) only when the mount block or the install script itself changed. Memory data under `<dsh-home>/memoplus4dsh/` is untouched either way.

> **Keep your own configuration outside the managed block.** `scripts/install.sh` rewrites the `# >>> memoplus4dsh` block wholesale, so anything you add *inside* it is lost on the next re-install. Put your additions in a separate patch entry targeting `id: memoplus4dsh` (see the example under [Prompt profiles](#prompt-profiles-and-embedding-upgrades)); because such an entry replaces the row's entire `config`, restate the keys you still want. Memory data is never affected.

**Verify the install**: `node scripts/doctor.mjs [--profile <name>] [--dsh-home <path>]` prints the mount status, the effective config (defaults vs your overrides), component probes (harrier/ONNX embedding chain, NER chain, model caches), and memory-data status (graph size, extraction queue, last extraction activity) — including hints for enabling the full-featured backends.


## Uninstall

```sh
scripts/uninstall.sh [--profile <name>] [--dsh-home <path>]
```

Fully reverses the install: the managed block and the `file:` dependency are removed, and dsh runs exactly as before. **Your memory data is kept** — the graph lives in `<dsh-home>/memoplus4dsh/`; delete that directory by hand if you want it gone. Reinstalling later picks the data up again (verified in [docs/m5-release-check.md](docs/m5-release-check.en.md)).

## Configuration

Set under the plugin's `config:` in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `extraction` | `turn_end` | `turn_end` extracts facts after every completed turn; `off` disables extraction |
| `injection` | `true` | Inject top-k relevant memories at the first step of each turn |
| `injectTopK` | `8` | Max memories injected per turn |
| `injectMaxChars` | `2000` | Character cap for the injected memory block |
| `injectMaxQueryChars` | `4000` | Skip retrieval+injection for longer user messages (document dumps, not queries) |
| `tools` | `true` | Register `memory_search` / `memory_remember` / `memory_visualize` / `memory_status` tools |
| `progressBridge` | `true` | Bridge goal/todo/schedule/plan progress events into the memory graph (M8) |
| `stateDedup` | `true` | Retrieval keeps only the newest bridge state event per entity+family; history stays in the graph |
| `embedding` | `true` | Local ONNX embeddings; failure degrades to keyword-only retrieval |
| `embeddingModel` | `multilingual` | Preset name: `multilingual` = distiluse-base-multilingual-cased-v2 (512-dim, ~135MB first-download, 50+ languages incl. Chinese); `english` = all-MiniLM-L6-v2 (384-dim, ~23MB); or any key you declare in `embeddingModels`. Switching re-embeds stored vectors lazily |
| `embeddingModels` | (none) | Extra or replacement presets by name: `{ repo, dim, hiddenDim?, projectionFile?, maxFileBytes }`. A stronger model for a machine that can afford it |
| `embeddingBackend` | `auto` | `auto` = harrier sidecar (microsoft/harrier-oss-v1-0.6b, 1024-dim, multilingual, ~10ms/text CPU) when its python env has `sentence-transformers`, else ONNX encoder; `onnx` / `harrier` to force. Query-side uses the model's trained instruction prompt |
| `embeddingSidecarModel` | `microsoft/harrier-oss-v1-0.6b` | sentence-transformers model the sidecar loads. The sidecar reports its real dimension at handshake, so a swapped model's stored vectors are correctly seen as stale and re-embedded |
| `embeddingSidecarQueryPrompt` | (model default) | Query-side instruction prompt name (`web_search_query` for the default model), or `null` for none. Defaults to none for any other model, whose prompt presets this plugin does not know |
| `embedPython` | (nerPython or python3) | Python executable for the harrier embedding sidecar |
| `hfBaseUrl` | `https://huggingface.co` | Mirror base URL for the embedding model download |
| `queryExpansion` | `true` | LLM query expansion during retrieval + verbatim-quote query distillation for injection (1024-token/30s bounded calls, results cached on disk per query) |
| `promptProfiles` | (none) | Named prompt profiles, tried in declaration order against the model each call actually runs on. Each is `{ name, match: { provider?, model? }, stages: { <stage>: { prompt, maxTokens?, timeoutMs?, reasoningEffort? } } }`; `*` is a wildcard. The built-in `default` profile holds the v0.1 prompts and is always the fallback |
| `promptProfilesDir` | `<dataDir>/prompts` | Directory of external profile files. Each `*.json` holds one profile, an array, or `{"profiles": [...]}`; files load in name order **after** the inline `promptProfiles`, so inline entries keep their matching order and files extend the set. A broken file fails at start instead of reaching the model |
| `promptProfile` | (auto) | Force one profile by name instead of matching the route |
| `prompts` | (none) | Per-stage overrides that beat every profile: `extraction` / `entityMerge` / `supersede` / `queryExpansion` / `queryDistill` |
| `entityMergeLlm` | `true` | LLM-adjudicated entity merge at extraction (embedding candidates + one bounded call per turn; only explicit `sure` merges) |
| `supersedeLlm` | `true` | LLM-adjudicated supersede detection (relation cardinality; older values marked `supersededBy`, history kept; re-mention guard + mark propagation) |
| `nerAssist` | `true` | NER candidate hints for extraction (detector chain: PyTorch sidecar → ONNX package → off) |
| `nerPython` | `python3` | Python executable for the NER sidecar (needs `torch gliner stanza` in that env; models auto-download on first use) |

### Prompt profiles and embedding upgrades

Every stage that calls a model owns a prompt plus its output cap, per-call timeout, and reasoning effort. They were hardcoded to one model family's tuning; a profile makes them configuration, and the profile is chosen per call from the model that call actually runs on — so switching the model in the Models page changes the prompts the *next* turn uses, with no reload.

"Actually runs on" matters when `extractionProvider` + `extractionModel` are set: those override the session's route for every auxiliary call, so profiles are matched on the **override**, not on the model in the composer. `memory_status` prints both the session route and the override, precisely so you can tell which one a profile matched.

Resolution order, highest first: `prompts.<stage>` → the selected profile (`promptProfile`, else the first `promptProfiles` entry whose `match` accepts that route) → the built-in `default`. `extractionMaxTokens` and `extractionCallTimeoutMs` are shorthand for the `prompts.extraction` entries. `memory_status` reports which profile each stage is using.

**Profiles can also live in external files**, which is what makes a profile set reviewable, versioned, and portable. The default directory is `<dataDir>/prompts` (`~/.dsh/memoplus4dsh/prompts`); `promptProfilesDir` moves it. `scripts/prompts.mjs` imports and exports with the same validation the plugin applies:

```sh
npm run build                                            # the CLI reuses the built loader
node scripts/prompts.mjs init --name my-models           # write an example file
node scripts/prompts.mjs list                            # profiles in the directory, with their files
node scripts/prompts.mjs validate ./team-profiles.json   # validate only, write nothing
node scripts/prompts.mjs import ./team-profiles.json --name team
node scripts/prompts.mjs export --out /tmp/all.json --include-default
```

An import is validated with `validateProfiles` first — a missing required placeholder, an unknown stage, or a non-positive bound is refused before anything is written. Profiles are read at dsh start, so an import becomes live on restart; resolution itself is per call, so nothing else is needed.

### Settings page (Web GUI)

The plugin registers a `memoplus4dsh` namespace on the settings service, so **Settings → Plugins → Plugin configuration** shows a "memoplus4dsh memory plugin" card editing the two fields above: `promptProfile` (force one profile) and `promptProfilesDir` (external profile directory). The tab renders the intersection of a served namespace and a card registered on that key; both halves ship in this package (Host half `src/settings.ts`, browser half `src/client/`), with no change to dsh itself.

A save takes effect immediately: the plugin takes the new value and rebuilds the prompt registry, so the next call uses it (`memory_status` reflects it right away). A mistyped profile name is refused by the Host with its reason instead of silently falling back. Every other setting still comes from the `cordis.yml` entry; the card does not take them over.

The browser half is `lib/client.js`, produced by `npm run build` (esbuild into the `window.__ModuleLoader__.load({ id, factory })` lazy factory dsh's client module system requires). Adding the card for the first time needs a dsh restart, because the client bundle graph is scanned from Loader entries at start; changing card code afterwards needs only a page reload.

```yaml
# Put your own configuration OUTSIDE the managed block that scripts/install.sh
# rewrites (a re-install replaces that block wholesale, dropping anything you
# added inside it). A patch entry targeting an existing id replaces the whole
# `config`, so restate the keys you still want alongside your additions.
- id: memoplus4dsh
  config:
    extraction: turn_end                   # restated: the managed block's keys
    injectTopK: 8
    promptProfile: deepseek-flash          # force one, or omit to match by route
    promptProfiles:
      - name: deepseek-flash
        match: { model: 'deepseek-*' }
        stages:
          entityMerge:
            maxTokens: 8192
            reasoningEffort: 'off'
      - name: glm
        match: { provider: 'opencode-go*', model: 'glm-*' }
        stages:
          extraction: { prompt: '<your template with {turn_text}>' }
    embeddingModels:
      multilingual-mpnet: { repo: sentence-transformers/paraphrase-multilingual-mpnet-base-v2, dim: 768, maxFileBytes: 2147483648 }
    embeddingModel: multilingual-mpnet
    embeddingSidecarModel: sentence-transformers/paraphrase-multilingual-mpnet-base-v2
```

A profile prompt must keep its stage's input placeholder — `{turn_text}` for extraction, `{lines}` for both adjudication stages, `{query}` for both query-side stages (checked at load, refuses the profile otherwise). `{known_entities}` and `{candidate_mentions}` are optional in the extraction prompt and only warned about.

> **Embedding-upgrade limits, stated honestly.** The sidecar applies the query instruction through sentence-transformers' `prompt_name`, i.e. a *named preset defined by the model*. Models that instead require a **text prefix** (`intfloat/multilingual-e5-*` wants `query: ` / `passage: `, `BAAI/bge-*` wants a similar instruction) have no such preset, so with those the query side embeds bare — it still works, but without the prefix the model was trained with. Prefer a model that needs no prefix (`sentence-transformers/paraphrase-multilingual-mpnet-base-v2` is a drop-in stronger option at 768 dims). Text-prefix support is not implemented; it is tracked as a follow-up.
>
> The sidecar path also downloads whatever the model needs on first use, and a model swap re-embeds the stored vectors lazily — expect the first retrieval after a swap to be slower.

> The plugin resolves `python3` from the **dsh process** PATH — when dsh is launched from your shell it inherits that environment, so an interpreter that already has the packages works with zero configuration. If yours does not, `scripts/setup-python.sh` creates a dedicated venv (sentence-transformers + torch/gliner/stanza) and prints the exact `nerPython` / `embedPython` lines to paste into `cordis.patch.yml`.
| `dataDir` | `<dsh-home>/memoplus4dsh` | Plugin data directory (journal, snapshots, model cache, expansion cache) |
| `extractionProvider` / `extractionModel` | session's own route | Override the model route used for extraction/expansion calls |
| `extractionMaxTokens` | `8192` | Output cap for extraction calls (reasoning models need the headroom) |
| `extractionCallTimeoutMs` | `120000` | Per-call timeout; a stalled endpoint fails fast into the retry queue |
| `extractionMaxRetries` | `2` | Retries after the first attempt; exhausting them starts a failure round and the turn is kept for retry |
| `extractionMaxFailureRounds` | `3` | Failure rounds before a turn is abandoned (one round exhausts `extractionMaxRetries`). Below the cap the turn is retried on the next turn and on the next start; at the cap it is recorded as `abandoned` and reported by `memory_status` / doctor as memories not written |
| `extractionConcurrency` | `1` | Extraction worker pool size; `1` is strict serial. Raise only when the endpoint tolerates overlapping extraction calls |
| `snapshotThreshold` | `1000` | Journal ops between snapshot compactions |
| `debug` | `false` | Diagnostic switch. Writes a `listener-saw` trace per session event and an `llm-empty` record for empty-content calls into `extraction-debug.jsonl` (~1000 lines/day even when healthy). **Off by default and never enabled for users**; turning it off does not affect the loss ledger (`failed` / `abandoned` / `requeue` stay unconditional) |

Extraction consumes your configured model's API quota — set `extraction: off` to opt out.

## Test instance

```sh
scripts/test-harness/start-test.sh   # isolated DSH_HOME under <workspace>/test, prints authenticated URL
scripts/test-harness/stop-test.sh
scripts/test-harness/reset-test.sh   # stop + wipe the test DSH_HOME
```

`MEMOPLUS4DSH_TEST_DIR` overrides the test directory. Real-LLM scenario tests: `node scripts/test-harness/run-scenarios.mjs` (requires `DEEPSEEK_API_KEY` in the environment; see [docs/m4-scenario-test.md](docs/m4-scenario-test.en.md)).

## Development

```sh
npm install
npm run build
npm test
```

Docs: [design](docs/design.en.md) · [M2 notes](docs/m2-notes.en.md) (store/extraction) · [M3 notes](docs/m3-notes.en.md) (retrieval/injection) · [M4 scenario tests](docs/m4-scenario-test.en.md) · [known issues](docs/known-issues.en.md)

## Acknowledgments & Disclaimer

Co-authored with Kimi K3 Thinking (high).

Disclaimer: this project merely used Kimi K3 as a development assistant. It is not affiliated with, endorsed by, or sponsored by Moonshot AI (月之暗面).

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
