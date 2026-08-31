/**
 * Bridges from dsh-internal events (schedule/goal/todo changes) into the
 * memory graph, so schedules, goals, and preferences live in the same graph
 * as conversational facts (docs/design.md §2.4).
 *
 * FIXME(M-later): not implemented in M2. Planned shape: each bridge listens
 * to its source event, projects the change into {@link MemoryStore} as a
 * `MemoryEvent` whose `sourceSession` names the bridge and whose
 * `sourceTurn` is -1, with the verbatim change text in `normalizedText`.
 */

import type { MemoryStore } from './store.ts'

/** A bridge projects one dsh-internal event family into the memory graph. */
export interface MemoryBridge {
  /** Stable bridge name, used in logs and `sourceSession` prefixes. */
  readonly name: string
  /** Detach every listener the bridge registered. */
  dispose(): void
}

/**
 * Register all available bridges. M2 registers none; the list exists so M3+
 * can add bridges without touching the plugin entry's control flow.
 * @returns the mounted bridges (empty in M2).
 */
export function registerBridges(_store: MemoryStore): MemoryBridge[] {
  return []
}
