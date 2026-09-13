# `profiles/` — reference prompt profiles and their measurement

> 中文：[README.zh.md](README.zh.md)

This directory is **not** read by the plugin at runtime. The plugin loads profile
files from `<dataDir>/prompts` (`promptProfilesDir` moves it), so everything here
is a *source* you copy or import from — see
[Using the reference profile](#using-the-reference-profile).

## What is here

| Path | What it is |
| --- | --- |
| `deepseek-v4.1-flash.json` | **The reference profile.** Model-matched (`match.model = "deepseek-v4.1-flash*"`, no `provider` — the same model name means the same model, whichever route serves it). Its extraction prompt is byte-identical to the candidate that measured best; it also pins `maxTokens: 8192` and `reasoningEffort: "off"`. |
| `candidates/*.json` | The candidates the reference was chosen from, as loadable profiles: `extraction-a-literal-hygiene` (A: no values as entity names), `extraction-b-identity-discipline` (B: similar names are not the same entity), `extraction-c-format-bilingual` (C: 9-column strictness + language of names and facts), `extraction-d-combined` (D: A+B+C merged). |
| `candidates/*.prompt.txt` | The prompt text of each candidate — the editable source, and the single source of truth for the reference profile too (its prompt is generated from C's file, so the two cannot drift). `scripts/build-candidate-profiles.mjs` wraps them into the `.json` files and validates the result. |
| `ab-corpus.jsonl` | The frozen A/B corpus: 18 real turns (one JSON object per line, with `id`, `kind`, `source`, `category`, `why`, `features`, and the turn `text`). |

Nothing here is part of the published npm package (`package.json` ships `lib`
only), and `profiles/candidates/` is a subdirectory, so even pointing
`promptProfilesDir` at `profiles/` loads nothing.

## Using the reference profile

```sh
npm run build                                  # scripts/prompts.mjs reuses the built loader
node scripts/prompts.mjs validate profiles/deepseek-v4.1-flash.json
node scripts/prompts.mjs import profiles/deepseek-v4.1-flash.json --name deepseek-v4.1-flash
# or simply: cp profiles/deepseek-v4.1-flash.json ~/.dsh/memoplus4dsh/prompts/
```

Profiles are read at dsh start, so restart dsh once. `memory_status` then reports
the profile each stage resolved to. Set `promptProfile: default` to go back to the
built-in v0.1 prompts without deleting the file.

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
