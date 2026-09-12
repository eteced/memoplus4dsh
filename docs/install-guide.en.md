# Installation Guide (for deployers)

> 中文：[install-guide.md](install-guide.md)

Complete steps from zero to working. Prerequisites: dsh (`@deepseek-ai/dsh@0.1.2-alpha.3`) and Node `^22.19 || >=24` installed, npm on PATH (or specify it with `NODE_BIN=/path/to/bin`); the install/uninstall scripts also need `python3` (used to rewrite the profile's `cordis.patch.yml`).

## 1. Get and Build the Plugin

```sh
git clone <repo-url> memoplus4dsh
cd memoplus4dsh
```

> No manual `npm install` / `npm run build` needed — on its first run
> `install.sh` checks for and installs the devDependencies required to build
> (`npm ci` when the lockfile is present), then builds automatically.
> To run the unit tests first, do `npm install && npm test` manually
> (onnxruntime-node is an optional dependency; if it fails to install, nothing
> breaks — retrieval just degrades to keyword-only).

## 2. Install into a dsh Profile

```sh
scripts/install.sh                    # default --profile web, --dsh-home $DSH_HOME or ~/.dsh
scripts/install.sh --profile sdk      # install into another profile
```

The script does three things (all idempotent, fully reversible by `uninstall.sh`):

1. Builds the plugin (tsc → lib/);
2. Initializes the profile the official dsh way if it doesn't exist, then `npm install <plugin-dir>` (`file:` dependency + symlink, local changes take effect after rebuild);
3. Writes a managed block into the profile's `cordis.patch.yml` to mount the plugin (with default config: `extraction: turn_end`, `injectTopK: 8`).

No dsh core files are modified.

## First run: model downloads (one-time, then served from local cache)

Models are downloaded lazily on demand — **the first few conversations' extraction/retrieval will be slower** (downloads run in the background), then everything returns to normal:

- ONNX multilingual embedding model: ~135MB (on by default; acts as the fallback when harrier is active)
- harrier 0.6B embedding model: ~1.2GB (only when `python3` has sentence-transformers)
- GLiNER / stanza NER models: ~600MB (only when torch/gliner/stanza are installed)

Downloads default to huggingface.co; if that is slow or blocked, set `hfBaseUrl: 'https://hf-mirror.com'` in the config.

## 3. Configuration (Optional)

Edit the `config:` on the plugin line in `<dsh-home>/profiles/<profile>/cordis.patch.yml`. Common options:

- `extraction: 'off'` disables automatic extraction (saves API quota);
- `embedding: false` disables local embedding (pure keyword retrieval);
- `nerAssist: false` disables NER candidate hints (on by default; detector fallback chain: PyTorch sidecar → ONNX bundle → no hints);
- `nerPython: '/path/to/python'` specifies the python for the NER sidecar (that environment needs `torch gliner stanza`; the sidecar auto-downloads GLiNER/stanza models on demand. Install: `pip install torch --index-url https://download.pytorch.org/whl/cpu && pip install gliner stanza` — optional enhancement; without it, automatic fallback, functionality unaffected);
- `hfBaseUrl: 'https://hf-mirror.com'` model-download mirror for restricted networks;
- Full configuration table: see [README](../README.md#configuration).

## 4. Verify the Plugin Works

Method A — composition tree (no server needed):

```sh
dsh web --dump-config | grep -A4 memoplus4dsh
# You should see id: memoplus4dsh and its config
```

Method B — runtime fiber status (after the web instance starts): query the host's `pluginInventory` Remote and confirm `memoplus4dsh`'s `fiberPhase` is `active`. See the curl approach at the end of `scripts/test-harness/start-test.sh` (exchange the token for a cookie, then POST `/api/pluginInventory/list`).

Method C — conversation smoke test:

1. Say to the agent: "My name is Xiaoming, and I like drinking Americano coffee."
2. Wait for the reply to finish (extraction is asynchronous after turn/end; wait a dozen seconds to a minute), then check that `<dsh-home>/memoplus4dsh/memory-graph.jsonl` contains an Americano-related event.
3. Open a new session and ask: "What do I like to drink?" — the session log should contain an injected message with `source.plugin === 'memoplus4dsh'`, and the agent should answer Americano.

Contents of the data directory `<dsh-home>/memoplus4dsh/`:

| File | Contents |
|---|---|
| `memory-graph.jsonl` | Memory graph log (entities/events, append-only + periodic snapshot compaction) |
| `extraction-debug.jsonl` | Extraction trace (enqueue/extracted/skipped), for troubleshooting |
| `query-expansion-cache.json` | Query expansion cache (delete it and it simply regenerates) |
| `models/` | MiniLM ONNX model downloaded on first retrieval (~23MB) |

## 5. Uninstall

```sh
scripts/uninstall.sh [--profile <name>] [--dsh-home <path>]
```

Completely removes the mount and the dependency; dsh returns to its pre-installation state (actually tested, see [m5-release-check.md](m5-release-check.en.md)). **Memory data is retained** in `<dsh-home>/memoplus4dsh/`; delete that directory manually to remove it entirely. Data picks up automatically after reinstallation.

## Test Instance (Sandbox-Isolated)

```sh
scripts/test-harness/start-test.sh   # isolated DSH_HOME + 127.0.0.1 + token, sandbox locked to the test directory
scripts/test-harness/stop-test.sh
scripts/test-harness/reset-test.sh   # stop and wipe the test DSH_HOME
```

## Known Limitations

See [known-issues.md](known-issues.en.md) — pay special attention to F1: on some third-party OpenAI-compatible endpoints, dsh 0.1.2-alpha.3 has all tool calls broken (affects `memory_search`/`memory_remember`; injection and extraction are unaffected); the official DeepSeek API does not have this problem.
