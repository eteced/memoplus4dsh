/**
 * Recorded-predicate feedback: the input side of the negation convention.
 *
 * Two things are easy to lose silently and both are pinned here:
 *  - the shipped tuned profile is a FULL prompt override, so a convention that
 *    only lives in EXTRACTION_PROMPT_TURN never reaches a profile user;
 *  - the placeholder must stay declared optional, or a profile carrying the
 *    block is refused at load.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatRecordedPredicates } from '../src/extraction.js'
import { OPTIONAL_PLACEHOLDERS } from '../src/prompts.js'
import { MemoryStore } from '../src/store.js'

const newStore = () => new MemoryStore({ dir: mkdtempSync(join(tmpdir(), 'memoplus-feedback-')) })

const addEvent = (store: MemoryStore, entity: string, predicate: string, text: string) => {
  const { entity: subject } = store.createOrResolve(entity, 'CONCEPT')
  store.addEvent({
    subjectEntityIds: [subject.id],
    objectEntityIds: [],
    predicate,
    normalizedText: text,
    details: '',
    timeExpr: '',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime: '2026-09-13T00:00:00.000Z',
    sourceSession: 'sess-1',
    sourceTurn: 1,
  })
}

describe('formatRecordedPredicates', () => {
  it('returns the predicates of entities the segment names, deduped', () => {
    const store = newStore()
    addEvent(store, 'dsh', 'support', 'dsh supports tools.')
    addEvent(store, 'dsh', 'support', 'dsh supports plugins.')
    addEvent(store, 'dsh', 'declare', 'dsh declares image input.')
    addEvent(store, 'unrelated', 'noise', 'unrelated holds noise.')

    const out = formatRecordedPredicates(store, store.listEntities(), 'now dsh is the topic')
    expect(out.split(', ').sort()).toEqual(['declare', 'support'])
    expect(out).not.toContain('noise')
  })

  it('says nothing when no named entity has history', () => {
    const store = newStore()
    addEvent(store, 'dsh', 'support', 'dsh supports tools.')
    expect(formatRecordedPredicates(store, store.listEntities(), 'a turn about nothing yet')).toBe('(none yet)')
    expect(formatRecordedPredicates(store, [], 'dsh')).toBe('(none yet)')
  })
})

describe('shipped tuned profile', () => {
  // A full prompt override drops whatever it does not restate, so the
  // convention has to be present in the profile's own text.
  const prompt = (JSON.parse(
    readFileSync(new URL('../profiles/deepseek-v4.1-flash.json', import.meta.url), 'utf8'),
  ) as { stages: { extraction: { prompt: string } } }).stages.extraction.prompt

  it('carries the recorded-predicate block and its placeholder', () => {
    expect(prompt).toContain('Recorded predicates: {recorded_predicates}')
    expect(prompt).toContain('copy that EXACT string into PREDICATE')
  })

  it('carries the polarity-in-OBJECT convention', () => {
    expect(prompt).toContain('Negation is carried by OBJECT, never by PREDICATE')
    expect(prompt).toContain('prefix the target with "not " in OBJECT')
  })

  it('states only the current value, so a correction cannot re-assert the old one', () => {
    expect(prompt).toContain('Record only what is true now')
  })

  it('keeps the placeholder declared optional so a profile carrying it loads', () => {
    expect(OPTIONAL_PLACEHOLDERS.extraction).toContain('{recorded_predicates}')
  })
})
