# M10 — Memory Graph Visualization (Interactive HTML)

> 中文：[m10-visualization.md](m10-visualization.md)

> Date: 2026-09-04 Status: **Implemented and verified** (2026-09-05)
> Requirement: users want to visualize existing memory — produce an interactive HTML graph.
>
> Verification record: `npm run build` passed; `npx vitest run` all 124 tests passed (including 3 cases in `tests/visualize.test.ts`);
> headless Chromium screenshot verification — both the large graph (real LME benchmark store, 7065 entities / 7830 events,
> graph area capped at 1200 displayed) and the small graph (1 entity) render normally, with no JS errors.
> One bug found and fixed during implementation: in the embedded JS, the first `relayout()` call happened before the `let needsDraw` declaration
> (a TDZ error prevented the whole page from rendering); the declaration was moved up (`src/visualize.ts`).

## Design

### Three Entry Points

1. **Core function** `renderGraphHTML(entities, events)` (`src/visualize.ts`): a pure function, graph data → self-contained HTML string (inline JS/CSS, zero external dependencies, works offline).
2. **CLI**: `scripts/visualize.mjs [--data-dir <path>] [--out <file>]` — resolves the default data directory (`$DSH_HOME/memoplus4dsh` or `~/.dsh/memoplus4dsh`), reuses `MemoryStore` to read the graph, generates the HTML, and prints the path.
3. **dsh tool `memory_visualize`** (`src/tools.ts`, gated by the `tools` switch): when the user says "show me my memory" in conversation, the model calls it, generates `<dataDir>/memory-graph.html`, and returns the path.

### Page Content

- Left-side force-directed graph: nodes = entities (colored by type PERSON/OBJECT/CONCEPT, size = event count), edges = events (subject→object), force layout (hand-written repulsion+spring, settles after ~250 iterations), draggable nodes.
- Hover highlights neighbors; clicking a node lists all of that entity's events on the right (sorted by mention_time descending).
- **Expression of the temporal dimension** (same methodology as the website animation): state-family events (goal/todo/schedule/plan/fact updates) are ordered by time in the list; non-latest ones carry a "history" mark but are **fully preserved** — history is never deleted from the graph.
- Top stats bar: entity count / event count / time range; search box (filter-and-highlight by entity name / event text).

### Data Methodology

- Data = the store's current entities + events (including historical old values; no state dedup — visualization presents the complete graph; dedup is a retrieval-layer semantic).
- Privacy: purely local files; nothing is uploaded anywhere.

### Acceptance

- Unit tests: renderGraphHTML output contains the embedded JSON data (entity/event counts match) and the key UI structure.
- Real-world test: generate from the benchmark's real graph (thousands of events) and verify rendering with headless Chromium screenshots.
