# throughline

Turns a technical book into a course you can actually start.

Point it at a PDF and it produces a prerequisite graph of concept-sized units — each with
learning objectives, a primer on what to watch for, and the exact page range to read —
displayed beside the rendered page. Answer the recall questions afterwards and they're
graded against the book's own pages.

Pilot book: *Designing Data-Intensive Applications* (613 pages, 12 chapters).

## The one rule

**Never drift from the book.** The book is the source of knowledge; this is a guide over
it, not a replacement for it. Nothing the system asserts is allowed to be untraceable to
a page.

That constraint is why the prerequisite graph is built from the book's own
cross-references rather than the model's opinion. Kleppmann wrote the graph down himself
— roughly 500 `Chapter N` references and 250 precise ones like `see "B-Trees" on page 79`
across DDIA. Every edge in the graph carries the sentence and page that produced it, and
you can click through to check it.

```
goal: understand consensus

  U02 replication basics
   └─ U09 replication lag
       └─ U18 linearizability
           └─ U29 total order broadcast
               └─ U31 consensus ★

  edge U18 ← U09 — cited, p.324:
    "…replication lag (see “Replication Lag” on page 161)…"
```

## Shape

- **Reading guide, not a substitute.** The AI writes objectives, primers and questions.
  It never rewrites the author.
- **Concept-boxed units.** One coherent idea per unit, however long that takes — not
  fixed 45-minute blocks, and not a 1:1 re-index of the book's sections.
- **Two-phase generation.** A cheap structural pass at ingest makes the whole roadmap
  visible in seconds; unit content is generated on first open and cached.
- **Generic engine.** DDIA is the pilot, not the target.

Stack: Next.js (App Router) · pdf.js for extraction *and* rendering · SQLite · Anthropic
SDK.

## Status

Early. The design is charted as a [wayfinder map](.scratch/readhelper/map.md) — locked
decisions, open questions as numbered tickets in
[`.scratch/readhelper/issues/`](.scratch/readhelper/issues/), and the fog that isn't
sharp enough to ticket yet. No application code exists.
