# 09 — second book for genericity

Type: task
Status: open
Blocked by: —
Parent: ../map.md

## Question

Pick and place a second technical PDF, with a **deliberately different** ToC style from
DDIA's, so the ingest pipeline is tested against genericity from ticket 03 onward rather
than discovered to be DDIA-shaped afterwards.

The engine is meant to be generic (decided during charting); DDIA is only the pilot. But
DDIA is unusually well-behaved: clean text layer, printed ToC with a full four-level
hierarchy and page numbers, dense self-citation. A pipeline tuned only to it will not
survive book two.

What "different" should mean — at least one of:

- a PDF **bookmark outline** instead of (or as well as) a printed ToC
- a **flat** ToC — chapters only, no subsections
- **per-part page renumbering**, or unnumbered front matter that breaks a constant offset
- **few or no self-citations**, so the DAG degenerates to the implicit sequence edges
  and we find out what the roadmap looks like when the book didn't write one down

This is HITL: Kobil picks the book. It's a task, not a decision — it unblocks judgement
on 03 and 04 rather than deciding anything itself.

**Resolution records**: the file path, its page count, whether it has a text layer, an
outline, or a printed ToC, and a rough citation count — the same facts already
established for DDIA on the map.
