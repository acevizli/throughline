# 02 — printed-page → PDF-index mapping

Type: prototype
Status: open
Blocked by: 01
Parent: ../map.md

## Question

How do we derive the printed-page → PDF-index mapping robustly, for any book, without
hardcoding an offset?

This is the foundation ticket. Three separate things all speak in **printed** page
numbers while the file addresses **indices**:

- the ToC (`Chapter 1 ... 3`)
- every citation (`see "B-Trees" on page 79`)
- the page the viewer pane must scroll to

Known for DDIA: front matter is roman-numbered, body arabic, ToC says Chapter 1 starts
at printed page 3, and that content sits near PDF page 25 — so the offset is roughly 22
but must not be assumed constant (some books restart numbering per part, or have
unnumbered plates).

Open sub-questions:

- Do we read page labels from the PDF (see 01), scrape the printed number out of the
  header/footer text, or triangulate from ToC entries? What's the fallback chain?
- Is the offset a single constant, or a piecewise map? Design for piecewise; DDIA may
  only exercise the constant case.
- How do we *verify* a derived mapping rather than trusting it? Proposal: take N ToC
  entries, jump to the mapped index, and confirm the section heading text is on that
  page. Same for a sample of citation targets. A mapping that fails its own audit should
  fail loudly at ingest, not silently mis-slice the book.

**Leaves working code**: a `printedToIndex(book, printedPage)` function plus its audit,
proven against DDIA.
