# 08 — data model and persistence

Type: grilling
Status: open
Blocked by: 04, 05, 06
Parent: ../map.md

## Question

Pin down the domain language and the SQLite schema behind it.

Blocked until 04, 05 and 06 land because edges, unit content and grading each define
their own shape — modelling before then is guessing.

Entities to settle, with `/domain-modeling`:

- **Book** — file path or content hash? A hash makes re-ingest of a moved file cheap and
  identifies the edition; a path is simpler and breaks the moment the PDF moves.
- **Unit** — id scheme, title, PDF page range, printed page range, chapter, order.
- **Edge** — from/to unit, kind (cited / implicit-sequence), and the audit payload: source
  page plus verbatim sentence. This is a required column, not an optional one.
- **Generation** — cached unit content, keyed so a prompt or model change can invalidate
  it. What exactly is the cache key?
- **Attempt** — one graded recall submission: the answer text, the verdict, the cited
  misses.
- **ObjectiveState** — per objective, derived from attempts or stored directly?

Cross-cutting:

- Is the structural pass (units + edges) stored separately from generated content, so a
  re-ingest can rebuild structure without discarding grading history?
- One SQLite file per book, or one for everything?
- Do units also exist as markdown on disk, or is SQLite the only home? Markdown is
  greppable and git-friendly; two sources of truth is a bug factory.
