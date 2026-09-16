# `profiles/` — reference prompt profiles and their measurement

> 中文：[README.zh.md](README.zh.md)

This directory is **not** read by the plugin at runtime. The plugin loads profile
files from `<dataDir>/prompts` (`promptProfilesDir` moves it), so everything here
is a *source* you copy or import from — see
[Using the reference profile](#using-the-reference-profile).

## The file format

**One file is one profile.** The file name is the profile name, so
`deepseek-v4.1-flash.prompts` is the profile `deepseek-v4.1-flash`, and
`promptProfile: deepseek-v4.1-flash` names that file. There is no list wrapper,
no `name` field, and no cross-file duplicate-name rule.

```
# comments and blank lines are allowed in the header
model: deepseek-v4.1-flash*      # optional; omit to make the profile manual-only
provider: *                      # optional

@@ stage extraction maxTokens=8192 reasoningEffort=off
You extract facts from conversation for a memory graph.

- Keep "quotes", backslashes \, tabs, pipes | and {turn_text} exactly as written.
@@ end

@@ stage entityMerge
Resolve every new mention below.
{lines}
@@ end
```

- **Bodies are verbatim.** Prompts are prose; nothing is escaped. Newlines,
  quotes, backslashes, tabs, `|`, `{placeholders}`, and non-ASCII all pass
  through byte-for-byte. JSON had to escape every one of them, which is why the
  format is not JSON.
- **The only reserved content is a body line that opens with `@@`.** One such
  line is a loud parse error naming the file and line rather than a silent
  truncation, so a prompt simply cannot contain one.
- **Stage options are optional.** `maxTokens`, `timeoutMs`, and
  `reasoningEffort` on the `@@ stage` line override that stage's built-in
  numbers. Declaring a stage means declaring its prompt: a block with an empty
  body is refused, so a profile cannot pin a budget without carrying the text.
  To change numbers alone, use the inline `promptProfiles` config instead.
- **`model` / `provider` are glob patterns.** `model` present means the profile
  matches routes automatically; `model` absent means it is reachable only
  through `promptProfile`. That is how a directory full of A/B candidates sits
  next to the live profile without any of them hijacking the route.
- **A profile may cover only some stages** — but never silently. `memory_status`
  reports, per stage, whether the prompt came from the profile or from the
  built-in default, and `scripts/prompts.mjs list` prints each file's coverage.

The five stages are `extraction`, `entityMerge`, `supersede`, `queryExpansion`,
and `queryDistill`.

## What is here

| Path | What it is |
| --- | --- |
| `deepseek-v4.1-flash.prompts` | **The reference profile**: all five stages in one file. Matched on the model name only (`model: deepseek-v4.1-flash*`, no `provider` — the same model name means the same model, whichever route serves it). Its extraction body is the tuned prompt that measured best of four candidates, with `maxTokens=8192` and `reasoningEffort=off` pinned; the other four stages carry the built-in prompts verbatim, so the file is a complete worked example of the format. |
| `candidates/*.prompts` | The candidates the reference was chosen from: `extraction-a-literal-hygiene` (A: no values as entity names), `extraction-b-identity-discipline` (B: similar names are not the same entity), `extraction-c-format-bilingual` (C: 9-column strictness + language of names and facts), `extraction-d-combined` (D: A+B+C merged). Each covers `extraction` only and declares no `model:`, so it can never be selected by a route — the A/B harness names them explicitly. |
| `ab-corpus.jsonl` | The frozen A/B corpus: 18 real turns (one JSON object per line, with `id`, `kind`, `source`, `category`, `why`, `features`, and the turn `text`). |

`package.json` ships `lib` and `profiles`; `profiles/candidates/` is a
subdirectory, so pointing `promptProfilesDir` straight at `profiles/` loads
nothing (the loader does not recurse).

## Using the reference profile

```sh
npm run build                                  # scripts/prompts.mjs reuses the built loader
node scripts/prompts.mjs validate profiles/deepseek-v4.1-flash.prompts
node scripts/prompts.mjs import profiles/deepseek-v4.1-flash.prompts
# or simply: cp profiles/deepseek-v4.1-flash.prompts ~/.dsh/memoplus4dsh/prompts/
```

Profiles are read at dsh start, so restart dsh once. `memory_status` then reports
the prompt source of each stage. Set `promptProfile: default` to go back to the
built-in prompts without deleting the file.

Want the built-in prompts as an editable starting point? Export them:

```sh
node scripts/prompts.mjs export --out /tmp/start --include-default
# /tmp/start/builtin-default.prompts — all five stages, verbatim
```

## Reproducing the measurement

```sh
node scripts/build-ab-corpus.mjs --print-index      # the corpus and its coverage
node scripts/ab-extraction-prompts.mjs --dry-run    # the plan, zero calls
node scripts/ab-extraction-prompts.mjs              # baseline vs every candidate (18 turns)
node scripts/ab-extraction-prompts.mjs --score-raw /tmp/ab-raw.jsonl   # re-score, no calls
node scripts/audit-literal-entities.mjs             # the same name classes in the live graph
```

The results and their limits are written up in
[docs/extraction-prompt-tuning.md](../docs/extraction-prompt-tuning.md) with the
generated tables in [docs/ab-extraction-prompts.md](../docs/ab-extraction-prompts.md).
