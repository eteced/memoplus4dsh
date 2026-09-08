# M5 release check

> 中文：[m5-release-check.md](m5-release-check.md)

Date: 2026-09-01. dsh `@deepseek-ai/dsh@0.1.2-alpha.3`, node v22.23.2.

## Uninstall/rollback verification (actually tested)

Target: the test instance web profile (`test/dsh-home`), whose memory graph already had 10 records (M4 scenario data) at the time.

1. **Before uninstall**: `cordis.patch.yml` contained the memoplus4dsh managed block (4 matches), the profile `node_modules/memoplus4dsh` symlink existed, `memory-graph.jsonl` had 10 lines.
2. **Ran** `uninstall.sh --profile web --dsh-home test/dsh-home`:
   - patch.yml managed block removed (0 matches) ✓
   - `file:` dependency removed from the profile `package.json` (0 matches) ✓
   - `node_modules/memoplus4dsh` symlink gone ✓
3. **Launch without the plugin**: `dsh web --dump-config` succeeded with no memoplus4dsh in the composition tree; `dsh web` actually started to readiness (printed the auth URL) ✓
4. **Reinstalled** with `install.sh --profile web`: managed block restored (4 matches), symlink restored, build passed ✓
5. **Data preserved**: `memory-graph.jsonl` still 10 lines, content verbatim-identical (the dentist appointment / Rust / green tea and other M4 facts all present) ✓
6. **Run after reinstall**: all three start-test.sh checks passed, pluginInventory reported memoplus4dsh **ACTIVE** ✓ (then stopped via stop-test.sh)

Two script problems were found and fixed along the way: machine-private path hardcoding (parameterized to derive from the script location + `NODE_BIN`/`MEMOPLUS4DSH_TEST_DIR` environment overrides), and `PLUGIN_DIR` derivation being one directory level off (fixed, and the mistakenly created `memoplus4dsh/test/` was cleaned up).

## Leak scan

- `grep -rn 'sk-[A-Za-z0-9]\|api[_-]key\|/home/claw'` (excluding node_modules): only a false hit on the package name `dsh-tool-ask-user` in package-lock; no keys/tokens/private paths ✓
- `git ls-files` inventory: src/ tests/ docs/ scripts/ + package.json/tsconfig/README/LICENSE/.gitignore; no data files, no logs, no credentials ✓ (`data/`, `*.log`, `.env*`, `test-harness/dsh-home/` are all in .gitignore)

## Final quality gates

- `npx tsc -p tsconfig.json` exit 0 (checked the exit code directly; an earlier pipeline had swallowed a tsc failure — the lesson was recorded in a commit)
- `npm test`: 92/92 green
- `git status`: clean

## Releasability conclusion

**Meets the v0.1 releasability bar**: the skeleton mounts; memory write/recall/injection/tool paths were validated under a real LLM (M4: S1/S3/S4/S5/S6 passed; S2's 2/3 and the blocked tool path are both attributable to upstream F1, not plugin defects); install/uninstall is fully reversible and actually tested; no credential leaks. Before release, keep a prominent F1 notice in README/known-issues (already written).
