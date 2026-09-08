# M2 notes — Memory graph storage + turn/end async extraction

> 中文：[m2-notes.md](m2-notes.md)

Date: 2026-09-01. Scope: `src/store.ts`, `src/extraction.ts`, `src/bridges.ts` (placeholder), `src/index.ts` wiring, `tests/` (vitest, 41 cases).

## Data model (changes relative to the Python version)

- Entity types narrowed to **PERSON / OBJECT / CONCEPT** (the design.md §2.3 decision; the Python version had 7 types including ORG/PLACE/EVENT). The pipe parser silently drops lines with other types, matching the Python version's handling of unknown types.
- Events keep dual time anchors: `eventTime` (when the thing happened, ISO or null + `eventTimePrecision`) and `mentionTime` (when it was mentioned, taken from the turn/end event's `time`). `timeExpr` is always preserved verbatim.
- **M2 parses ISO dates only** (`resolveEventTime`: day precision); relative times ("last Saturday", etc.) all become `eventTime=null, precision='unknown'`, with the verbatim expression kept in `timeExpr`. A full port of the Python `TimeResolver` belongs to M3's `temporal.ts` (the retrieval side needs it too).
- Python's `event_type` (STATE/ACTION/...) and `confidence` were not ported — the extraction side never produced non-STATE values, and the retrieval side never used them.
- An event's subject/object are resolved to entity ids at write time (the Python version deferred this to the writer). OBJECT column text uniformly becomes a CONCEPT entity — the cost is possibly too many object entities, the benefit is that graph queries (`eventsForEntity`) work naturally.

## Storage

- JSONL append-only writes (`memory-graph.jsonl`), four ops: `entity.upsert / entity.delete / event.add / event.delete`. One `appendFileSync` per line (single-line small writes, atomic on POSIX); on load, line-by-line `JSON.parse`, bad lines skipped and counted + `onCorruptLine` callback warning.
- Snapshot compaction: when the op count since the last snapshot exceeds `snapshotThreshold` (default 1000) or on `close()`, rewrite the whole thing via tmp file + rename into a pure upsert set.
- Entity resolution `createOrResolve`: name normalization (trim + whitespace collapse + case-insensitive) → alias index exact match (type-constrained) → optional embedder cosine near-duplicate merge (threshold default 0.9, aligned with Python's conservative merge approach but without the grey-zone bisection). The embedding is an optional injectable interface; M2 does not wire a real model (that's `embedding.ts`'s job).
- Delete semantics: `deleteEntity` removes the entity from the subject/object lists of all events (the events themselves are kept); `deleteEvent` only deletes the event. Both have corresponding JSONL ops, so replayed state is consistent (tested).

## Extraction

- The prompt ports `_EXTRACTION_PROMPT_TURN` (the single-turn version without existing-memories context — M2 has no retrieval pipeline, so the WITH_CONTEXT/MULTISTEP/BATCH variants are not introduced yet). All validated rules are preserved: pronoun resolution, anaphora concretization, list splitting, `is` static attributes, the DETAILS column, verbatim time with no conversion. Examples keep the neutral Alice/Bob entities.
- `known_entities` filtering: only names that substring-match the current turn text go into the prompt + a 4000-char hard cap (the lesson from the Python side where 92k chars blew up the endpoint).
- Parser: pipe lines → entity/event dicts, tolerant of bad lines/headers/short lines; `<field>` pseudo-tag normalization and T# tag skipping match Python. The `fact.length >= 12` quality gate lives at the pipeline layer (not in the parser).
- Speaker enforcement: `Name:` lines in the turn text yield a speaker; the corresponding entities/events are forced to PERSON.
- Queue: serial (one LLM call at a time), deduped by `(sessionId, turn)`, bounded retries (default 2 retries = 3 attempts) then skip with an `onSkip` record. The queue promise chain never rejects; one bad turn never blocks later writes. Empty LLM output counts as failure (goes to retry). Unlike Python's "slightly vaguer facts beat none": we do not fall back to a smaller model — there is no second model available on the dsh side, so after retries we just skip.

## dsh wiring

- Trigger: `ctx.on('session/event')` filters `turn/end` with `reason.kind === 'completed'` (aborted/error turns are not extracted). Turn text is rebuilt from the session log: `user/message` events after that turn's `turn/start` plus `assistant/message` events whose `data.turn` matches; only text blocks are taken, prefixed with `User:`/`Assistant:` (for the prompt's speaker rule).
- LLM routing: by default reuse the session's `requestHeader().config` (provider/model) — whatever model the user uses, extraction uses the same; the `extractionProvider/extractionModel` config can override. Calls go through `ctx.llm.stream()`, assembled from `text-delta`, with zero new keys/endpoints.
- Data directory: `config.dataDir ?? $DSH_HOME/memoplus4dsh ?? ~/.dsh/memoplus4dsh` (reads only the DSH_HOME path variable, no keys).
- Lifecycle: all registrations live in one `ctx.effect`; on dispose, `store.close()` makes the final snapshot.
- devDependencies uniformly bumped to `@deepseek-ai/dsh-*@0.1.2-alpha.3` (consistent with the dsh runtime validated in M1; the rc.1 tree contains `dsh-type-meta`, which is 404 on npm). These are pure type dependencies; at runtime only the peer cordis is used.

## Known boundaries (left for M3+)

- `bridges.ts` has only interface placeholders; the schedule/goal/todo bridges are not implemented.
- Relative times are not resolved; `existing_memories` contextualized extraction (dedup/refinement) will be evaluated once the retrieval pipeline is in place.
- Extraction consumes the user's API quota (recorded in design.md §6); config can set `extraction: off` to disable it.
