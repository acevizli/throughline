# 03 — unit boundary derivation

Type: prototype
Status: open
Blocked by: 02
Parent: ../map.md

## Question

Units are **concept-boxed** — one coherent idea each, variable length — but generation is
**two-phase**, so the whole unit list has to fall out of a *cheap* ingest pass. Those two
decisions are in tension: the ToC gives sections, not concepts.

Is running the ToC through the model enough?

The DDIA ToC is roughly 1.5k tokens — trivially affordable at ingest, and it carries
Part → Chapter → H2 → H3 with printed page numbers, which is real structural signal. The
question is whether titles alone produce good concept boundaries, or whether the model
needs to see section text (which is no longer cheap).

Sub-questions:

- Does a unit ever **split** an H3, or is an H3 the atom and units only ever merge them?
  (Merging-only keeps page ranges exact and derivable; splitting means finding a boundary
  inside prose.)
- Where does the estimated duration come from — page count, or the model's judgement?
- What happens to non-teaching matter: preface, summaries, "Further Reading",
  references, index? Dropped, or units of their own?
- Does every unit belong to exactly one chapter, or can a concept span chapters?

**Method**: generate the real DDIA unit list from the actual ToC and read it together —
the judgement is "would I want to sit down to that unit", which is Kobil's to make.

**Leaves working code**: a ToC parser plus the boundary pass, emitting units with ids,
titles, and PDF page ranges.
