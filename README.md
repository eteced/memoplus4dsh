# memoplus4dsh

Unified long-term memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

One coherent entity-time fused memory graph for everything an agent needs to remember — facts, preferences, plans, and events from conversations — instead of scattered per-day markdown files. The core algorithms are ported from the memoplus/ETMS research codebase, validated on LoCoMo (82.9% under the mem0 protocol).

**Status: v0.1 implemented.** Architecture: [docs/design.md](docs/design.md). Known issues: [docs/known-issues.md](docs/known-issues.md).

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

Two model-facing tools are also registered: `memory_search` (active recall) and `memory_remember` (explicit "remember this"). Extraction reuses the session's own provider/model route — no new API keys.

## Requirements

- dsh `0.1.2-alpha.3` (the version this plugin is built and verified against; dsh is pre-release and may break compat)
- Node `^22.19 || >=24`
- Optional: `onnxruntime-node` (declared as an optional dependency) for local embeddings; without it retrieval degrades to keyword-only, nothing breaks

## Install

```sh
# from this repository; --profile defaults to web, --dsh-home to $DSH_HOME or ~/.dsh
scripts/install.sh [--profile <name>] [--dsh-home <path>]
```

The script builds the plugin, links it into the profile (`npm install <this dir>`), and mounts it via a managed block in the profile's `cordis.patch.yml`. No dsh source is ever modified. See [docs/install-guide.md](docs/install-guide.md) (中文) for a full walkthrough including verification.

## Uninstall

```sh
scripts/uninstall.sh [--profile <name>] [--dsh-home <path>]
```

Fully reverses the install: the managed block and the `file:` dependency are removed, and dsh runs exactly as before. **Your memory data is kept** — the graph lives in `<dsh-home>/memoplus4dsh/`; delete that directory by hand if you want it gone. Reinstalling later picks the data up again (verified in [docs/m5-release-check.md](docs/m5-release-check.md)).

## Configuration

Set under the plugin's `config:` in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `extraction` | `turn_end` | `turn_end` extracts facts after every completed turn; `off` disables extraction |
| `injection` | `true` | Inject top-k relevant memories at the first step of each turn |
| `injectTopK` | (set by install: 8) | Max memories injected per turn |
| `injectMaxChars` | `2000` | Character cap for the injected memory block |
| `tools` | `true` | Register `memory_search` / `memory_remember` tools |
| `embedding` | `true` | Local ONNX MiniLM embeddings; failure degrades to keyword-only retrieval |
| `hfBaseUrl` | `https://huggingface.co` | Mirror base URL for the embedding model download |
| `queryExpansion` | `true` | LLM query expansion during retrieval (results cached on disk per query) |
| `dataDir` | `<dsh-home>/memoplus4dsh` | Plugin data directory (journal, snapshots, model cache, expansion cache) |
| `extractionProvider` / `extractionModel` | session's own route | Override the model route used for extraction/expansion calls |
| `extractionMaxTokens` | `8192` | Output cap for extraction calls (reasoning models need the headroom) |
| `extractionCallTimeoutMs` | `120000` | Per-call timeout; a stalled endpoint fails fast into the retry queue |
| `extractionMaxRetries` | `2` | Retries after the first attempt; the turn is then skipped and logged |
| `snapshotThreshold` | `1000` | Journal ops between snapshot compactions |

Extraction consumes your configured model's API quota — set `extraction: off` to opt out.

## Test instance

```sh
scripts/test-harness/start-test.sh   # isolated DSH_HOME under <workspace>/test, prints authenticated URL
scripts/test-harness/stop-test.sh
scripts/test-harness/reset-test.sh   # stop + wipe the test DSH_HOME
```

`MEMOPLUS4DSH_TEST_DIR` overrides the test directory. Real-LLM scenario tests: `node scripts/test-harness/run-scenarios.mjs` (requires `DEEPSEEK_API_KEY` in the environment; see [docs/m4-scenario-test.md](docs/m4-scenario-test.md)).

## Development

```sh
npm install
npm run build
npm test
```

Docs: [design](docs/design.md) · [M2 notes](docs/m2-notes.md) (store/extraction) · [M3 notes](docs/m3-notes.md) (retrieval/injection) · [M4 scenario tests](docs/m4-scenario-test.md) · [known issues](docs/known-issues.md)

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
