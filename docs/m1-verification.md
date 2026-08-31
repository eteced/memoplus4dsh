# M1 verification — empty plugin loads in a real dsh instance

Date: 2026-08-31. dsh: `@deepseek-ai/dsh@0.1.2-alpha.3` (npm), node v22.23.2.

## Method

```sh
scripts/test-harness/reset-test.sh    # pristine DSH_HOME (test/dsh-home)
scripts/test-harness/start-test.sh    # install plugin + boot dsh web
```

`start-test.sh` performs three independent checks; all must pass:

1. **Boot-free composition check** — `dsh web --dump-config` prints the
   composed plugin tree; the plugin row and the pinned sandbox policy must
   appear:

   ```
   - id: memoplus4dsh
     name: memoplus4dsh
     config:
       extraction: turn_end
       injectTopK: 8
   - id: sandbox-policy
     name: '@deepseek-ai/dsh-sandbox-policy'
     config:
       mode: workspace-write
       workspaceRoot: <workspace>/test
   ```

2. **Readiness** — the server prints `dsh web: http://127.0.0.1:<port>/?token=...`
   (the URL line is emitted only after the Loader tree settles, so a plugin
   that fails to import or apply would prevent it). Observed:

   ```
   ==> dsh web up (pid 326593)
       URL:   http://127.0.0.1:39857/?token=<redacted>
   ```

3. **Runtime fiber check** — the host's `pluginInventory` Remote is queried
   over `/api` (token exchanged for the signed cookie, then
   `POST /api/pluginInventory/list` with
   `{"type":"client-request","rpcId":...,"method":"pluginInventory/list","payload":{"args":{}}}`).
   Result:

   ```
   plugin: pluginInventory reports memoplus4dsh ACTIVE
   ```

   i.e. the snapshot contains
   `{"entryId":"include:memoplus4dsh","moduleName":"memoplus4dsh","enabled":true,"fiberPhase":"active"}`
   — the plugin's `apply()` ran to completion (the system-prompt section and
   the logger call are the first statements in it).

## Why not the log line

The plugin logs `memory plugin loaded` through `ctx.logger`, but the shipped
web profile mounts no console logger (`@deepseek-ai/cordis-plugin-logger-console`
is not part of the npm distribution), so nothing reaches `web.log`. The
pluginInventory fiber state is the stronger signal anyway: it proves the
Loader imported the module and the fiber reached ACTIVE, which a throwing
`apply()` would prevent.

## Lifecycle checks performed

- `start-test.sh` twice in a row → second run prints the live URL, no duplicate process.
- `stop-test.sh` twice → second run is a no-op.
- `uninstall.sh --dsh-home test/dsh-home` → marker block removed from
  `cordis.patch.yml` (remaining entries keep it a valid list), `memoplus4dsh`
  dependency removed from the profile `package.json`, `node_modules/memoplus4dsh`
  symlink gone; reinstall via `install.sh` restores everything.
- `reset-test.sh` → stops the server and deletes `test/dsh-home`;
  the next `start-test.sh` rebuilds the profile from scratch (dsh-install
  npm cache kept).

## Known issues / notes

- Reused log file: `start-test.sh` records the byte offset of `web.log`
  before launching, otherwise a restart would match the previous instance's
  stale URL line (observed during bring-up; fixed).
- The authenticated URL must have its trailing `/` stripped before appending
  `/api/...`; `//api/...` returns 405 (observed; fixed in the script).
- `dsh plugin --profile web add <pkg>` was not used: it shells out to `pnpm`,
  which is not installed on this machine, and it would only help for packages
  declaring `dsh.bundle` (ours is a plain plugin). `npm install <dir>` gives
  the same resolvable `file:` dependency plus symlink, and mounting is done by
  the managed block in `cordis.patch.yml`.
