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
| `reasoningEffortPolicy` | `adapt` | What happens when a stage's effort is not supported by the route. `adapt` (default): the built-in `off` follows what dsh reports for that route — `off` when declared, else the route's lowest declared level (`low` on a route declaring only `low/high/max`), else the effort is omitted entirely for dsh and the provider to default; a user-set effort that is unsupported degrades the same way, with one warning per route. `strict`: send the configured effort as-is and let dsh refuse it (`UNSUPPORTED_REASONING_EFFORT`) |
| `thinkingTokenHeadroom` | `3` | Thinking-budget multiplier; `1` disables it. When the effort that actually goes on the wire is **not `off`** (thinking is on — the built-in `off` adapted to the lowest level, or the effort omitted), the stage's resolved `maxTokens` is multiplied by this factor to leave room for visible output: measured on this route, thinking on eats the whole 8192-token extraction budget and yields 0 visible characters. With `off` nothing is multiplied, keeping the old behaviour and the old cost. `STAGE_DEFAULTS` and the profile/override values themselves are unchanged; only the value actually sent is scaled, which is what `memory_status` shows per stage. On a route where `off` is dispatchable this multiplier never applies — declaring `off` is the recommended fix, and this is the fallback |
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

**A tuned reference profile ships in the repository** under `profiles/`, and it is measured rather than asserted. `profiles/deepseek-v4.1-flash.json` matches on the **model name only** (`match.model = "deepseek-v4.1-flash*"`, no `provider` — the same model name means the same model, whichever route serves it) and carries the extraction prompt that measured best of four candidates on this route (the win is mainly language consistency on Chinese turns — the report is explicit about what it did *not* improve), with `maxTokens: 8192` and `reasoningEffort: "off"` pinned. Copy it into `<dataDir>/prompts/` (or `scripts/prompts.mjs import`) and restart. The frozen corpus of 18 real turns (`profiles/ab-corpus.jsonl`), the candidates, the harness (`scripts/ab-extraction-prompts.mjs`), the graph-side audit (`scripts/audit-literal-entities.mjs`), the numbers, and — just as important — what the A/B did *not* show are in [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md).

**As of v0.2 the shipped default extraction prompt deliberately changed too.** It no longer equals v0.1 byte for byte: it now feeds **recorded predicates** back and encodes negation in `OBJECT` rather than in the predicate. Without that, an assertion and its retraction never pair — see [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md) §8. `tests/fixtures/v01-prompts.json` relaxes only the extraction entry, the other four stages stay pinned to v0.1, and the departure is recorded under the fixture's `deviations`.

### Turning thinking off: declare `off` on the route (recommended)

Extraction is a structured task, and thinking spends the output budget before any visible text exists. On the `opencode-go-extra/deepseek-v4.1-flash` route (`compat.thinkingFormat: deepseek`), the same extraction input at the same `max_tokens: 8192` measured: with thinking on (`reasoning_effort: low`) both runs ended `finish=length` with 0 visible characters and 8192/8192 tokens spent on reasoning; with thinking off (`thinking: {type: disabled}`) both runs ended `finish=stop` with 2399 and 2493 visible characters, 37 rows each, and 0 reasoning tokens. **Thinking tokens cannot be excluded from the output budget** — `thinking.budget_tokens`, `thinking_token_budget`, `thinking_budget`, and `thinking_budget_tokens` are each ignored by this gateway, and thinking still consumes `max_tokens` to the cap. What does work is **turning thinking off**, which brings the reasoning tokens to zero.

That requires the route to declare `off`: dsh validates an effort against the model's declared levels *before* dispatch and refuses `off` with `UNSUPPORTED_REASONING_EFFORT` on a hand-written model that has not declared it. Add `off` to the model's `reasoningEfforts` in `settings.yaml` (a valueless key means "`off` is selectable, send no effort parameter"; under this route's `thinkingFormat: deepseek` pi-ai then sends `thinking: {type: disabled}`):

```yaml
llm-pi-ai:
  providers:
    opencode-go-extra:
      # ... apiKeyEnv / api / baseURL / headers / compat, unchanged ...
      models:
        - id: deepseek-v4.1-flash
          # ...
          reasoningEfforts:
            off:            # ← added: dsh can now dispatch `off`
            low: low
            high: high
            max: max
```

Then let the stages actually fall to `off`: a profile must not pin `reasoningEffort: low` (the built-in default is already `off`), or it may say `"reasoningEffort": "off"` explicitly. With both in place `reasoningEffortPolicy: adapt` has nothing to degrade and `thinkingTokenHeadroom` never multiplies — the whole 8192 (or the profile's `maxTokens`) goes to visible output. `thinkingTokenHeadroom` (default 3) remains the fallback for a route that genuinely cannot dispatch `off`: its effort is adapted to the lowest level, thinking is on, and without a bigger budget the failure above repeats. The factor is 3 because that is the smallest round multiplier that lifts the 8192 default above the 16384 the starvation consumed.

### Settings page (Web GUI)

The plugin registers a `memoplus4dsh` namespace on the settings service, so **Settings → Plugins → Plugin configuration** shows a "memoplus4dsh memory plugin" card editing the **11 keys** this namespace owns, grouped: `promptProfile` / `promptProfilesDir` (prompts), `injectTopK` / `reasoningEffortPolicy` / `thinkingTokenHeadroom` (retrieval & reasoning), `extractionConcurrency` / `extractionJobIntervalMs` / `extractionRetryDelayMs` / `extractionMaxRetries` / `extractionMaxFailureRounds` (extraction queue), `debug` (diagnostics). The tab renders the intersection of a served namespace and a card registered on that key; both halves ship in this package (Host half `src/settings.ts`, browser half `src/client/`), with no change to dsh itself.

Every row states **how it applies**:

| Apply semantic | Keys | Why |
|---|---|---|
| Live (next call) | `promptProfile`, `promptProfilesDir` | the profile registry is rebuilt on save |
| Live (next call) | `injectTopK`, `reasoningEffortPolicy`, `thinkingTokenHeadroom`, `debug`, `extractionMaxFailureRounds` | re-read at every use |
| **Restart** | `extractionConcurrency`, `extractionJobIntervalMs`, `extractionRetryDelayMs`, `extractionMaxRetries` | fixed when `ExtractionQueue` is constructed; the card marks these "restart to apply" and the plugin logs a warning rather than pretending |

A mistyped profile name or a negative number is refused by the Host with its reason, and invalid input blocks the save in the card itself (the draft is kept). `debug` is labelled "diagnostic switch, off by default, significantly increases log volume". Every other setting (`extraction`, `embedding*`, `promptProfiles`, `dataDir`, …) still comes from the `cordis.yml` entry (in practice the profile's `cordis.patch.yml`); the card does not take them over.

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

### Config import/export

**UI (the card's "配置导入导出" section)**: *Export (download JSON)* and *Copy to clipboard* produce the **full effective snapshot**; *Choose a file* and *paste JSON* import one. The import path is parse → structural validation → keep only this namespace's keys → per-field write (revision fence). "解析并预览" first shows **which keys will be written** and which are ignored; only "确认导入" writes. A bad file is refused outright and the settings document is left untouched.

**CLI (`scripts/config.mjs`, same keys and same rules as the card)**:

```sh
npm run build                                                 # the CLI reuses the build output
node scripts/config.mjs export --out /tmp/memoplus.json        # full effective snapshot + provenance
node scripts/config.mjs export                                 # without --out the JSON goes to stdout
node scripts/config.mjs import /tmp/memoplus.json --dry-run     # print the keys and the diff, change nothing
node scripts/config.mjs import /tmp/memoplus.json               # validate first, then write; backs the document up to /tmp/ (path printed)
```

**Format** (identical for the UI and the CLI):

```json
{
  "version": 1,
  "plugin": "memoplus4dsh",
  "exportedAt": "2026-09-13T13:52:59.857Z",
  "values": { "injectTopK": 8, "thinkingTokenHeadroom": 3, "debug": false },
  "sources": { "injectTopK": "cordis", "thinkingTokenHeadroom": "default", "debug": "default" },
  "notWritten": { "extraction": "turn_end" }
}
```

- `values` is the **full effective snapshot**: settings layer (`settings.yaml`'s `memoplus4dsh` section) > the same key in `cordis.patch.yml` > the plugin default. Keys no layer provides (`promptProfile`, `promptProfilesDir`) are absent.
- `sources` marks each key's provenance (`settings` / `cordis` / `default`).
- `notWritten` lists the composition-layer keys that are **not** owned by this namespace — the tool never writes them back.
- **An import writes only the settings layer's owned keys**, and a file carrying `sources` writes only `source=settings` keys (a hand-written file without `sources` writes every owned key it lists). So export-then-import never freezes an inherited value into an explicit override, and unknown keys are reported, not written.
- The number-list field (`extractionRetryDelayMs`) is edited in the card as **comma-separated numbers** (a pasted JSON array works too) and is always a JSON array in the exported/imported file.
- The CLI prints only this namespace's slice: secrets and unrelated content from other namespaces never appear in any output (JSON on stdout, notes on stderr).
- The CLI's import performs leaf-level writes on the YAML document, so **comments, anchors, and other namespaces are preserved**, and lands through a same-directory temp file plus rename (a running dsh watcher never sees a half-written document and hot-reads the change).

> **Embedding-upgrade limits, stated honestly.** The sidecar applies the query instruction through sentence-transformers' `prompt_name`, i.e. a *named preset defined by the model*. Models that instead require a **text prefix** (`intfloat/multilingual-e5-*` wants `query: ` / `passage: `, `BAAI/bge-*` wants a similar instruction) have no such preset, so with those the query side embeds bare — it still works, but without the prefix the model was trained with. Prefer a model that needs no prefix (`sentence-transformers/paraphrase-multilingual-mpnet-base-v2` is a drop-in stronger option at 768 dims). Text-prefix support is not implemented; it is tracked as a follow-up.
>
> The sidecar path also downloads whatever the model needs on first use, and a model swap re-embeds the stored vectors lazily — expect the first retrieval after a swap to be slower.

> The plugin resolves `python3` from the **dsh process** PATH — when dsh is launched from your shell it inherits that environment, so an interpreter that already has the packages works with zero configuration. If yours does not, `scripts/setup-python.sh` creates a dedicated venv (sentence-transformers + torch/gliner/stanza) and prints the exact `nerPython` / `embedPython` lines to paste into `cordis.patch.yml`.
| `dataDir` | `<dsh-home>/memoplus4dsh` | Plugin data directory (journal, snapshots, model cache, expansion cache) |
| `extractionProvider` / `extractionModel` | session's own route | Override the model route used for extraction/expansion calls |
| `extractionMaxTokens` | `8192` | Output cap for extraction calls (reasoning models need the headroom) |
| `extractionCallTimeoutMs` | `120000` | Per-call timeout; a stalled endpoint fails fast into the retry queue |
| `extractionMaxRetries` | `4` | Retries after the first attempt (5 attempts per round); exhausting them starts a failure round and the turn is kept for retry |
| `extractionRetryDelayMs` | `[15000,60000,180000,600000]` | Wait between attempts inside one round (last entry repeats, ±20% jitter). It was hardcoded `[5s,30s]` — too dense to outlast a provider outage lasting tens of seconds |
| `extractionJobIntervalMs` | `3000` | Minimum gap between job **starts** (`0` disables). This is what prevents a start-up burst: 14 queued jobs spread over 0s/3s/.../39s instead of firing back to back into a failing window |
| `extractionMaxFailureRounds` | `10` | Failure rounds before a turn is abandoned (one round exhausts `extractionMaxRetries`). Below the cap the turn is retried on the next turn and on the next start; at the cap it is recorded as `abandoned` and reported by `memory_status` / doctor as memories not written |
| `extractionConcurrency` | `3` | Extraction worker pool size. It does **not** raise the request rate: `extractionJobIntervalMs` is measured between job *starts*, so starts stay 3s apart however many slots exist. 3 keeps a job waiting out a retry backoff (up to 10 min) from starving the turns queued behind it — a retry wait now holds no slot at all, and a re-queued retry goes to the back of the queue. `1` is strict serial |
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

Co-authored with Kimi K3 Thinking (high) and DeepSeek V4.1 Flash.

Disclaimer: this project merely used Kimi K3 as a development assistant. It is not affiliated with, endorsed by, or sponsored by Moonshot AI (月之暗面).

Disclaimer: this project used DeepSeek V4.1 Flash for prompt tuning and code contributions (the prompt-tuning report is [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md)). It is not affiliated with, endorsed by, or sponsored by DeepSeek (深度求索).

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
