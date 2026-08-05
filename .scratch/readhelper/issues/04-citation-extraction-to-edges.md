# 04 — citation extraction → DAG edges

Type: prototype
Status: open
Blocked by: 03
Parent: ../map.md

## Question

Turn the book's own cross-references into prerequisite edges between units, with every
edge auditable back to the sentence that created it.

Two citation forms exist in DDIA, and they are not equally useful:

- **Precise**: `see "B-Trees" on page 79` — names a section *and* a printed page. Roughly
  250 across the book. These resolve to a single unit cleanly once 02 and 03 land.
- **Coarse**: `Chapter 9`, `discussed in Chapter 2` — roughly 500 across the book. These
  name a chapter with no page.

The open decision: **what do we do with coarse `Chapter N` references?** Edge to the
chapter's first unit, fan out to all its units, or drop them entirely? Fanning out
risks a hairball; dropping throws away two thirds of the signal; first-unit-only is a
guess dressed as a citation.

Sub-questions:

- **Direction.** A citation is not automatically a prerequisite. `see Chapter 9` pointing
  *forward* is "we'll get to this", which is not a dependency; pointing *backward* is
  "you should already know this", which is. Does direction alone decide, or does the
  surrounding phrasing matter?
- Plus the implicit **previous-unit-in-chapter** edge — is that every unit, or only
  within an H2 group?
- Cycles: two units citing each other is entirely plausible in a book. It's a DAG by
  name — how do we break cycles, and does breaking one lose real information?
- Is the resulting graph **navigable**, or a hairball? Check degree distribution and
  eyeball a real path (e.g. "what must I read to understand consensus?").

**Leaves working code**: an extractor and an edge resolver; each edge records its source
page and verbatim sentence.
