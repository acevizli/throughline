# 01 — pdf.js extraction capabilities

Type: research
Status: claimed
Blocked by: —
Claimed by: research subagent (charting session, 2026-08-05)
Findings: .scratch/readhelper/research/01-pdfjs-capabilities.md
Parent: ../map.md

## Question

Can one library — pdf.js — serve both ingest-time extraction and viewer-time rendering,
so the page coordinates we slice units on and the pages we display are guaranteed to
agree?

Specifically:

1. What does `getTextContent()` give us per page — items, transforms, positions? Is it
   enough to detect a printed page number in a header/footer, and to detect heading
   levels by font size/weight?
2. Does pdf.js expose **page labels** (`getPageLabels()`)? DDIA has roman-numbered front
   matter and arabic body pages — if pdf.js reads the PDF's page-label dictionary, the
   printed→index mapping may be free rather than inferred. Does *this* PDF actually
   carry that dictionary? (Producer: Antenna House PDF Output Library 2.6.0, PDF 1.4,
   `Tagged: no`.)
3. What's the story for running pdf.js **server-side in a Next.js route handler** (Node,
   no DOM)? Legacy build, worker setup, known pitfalls.
4. Rendering: what's the current recommended way to render a specific page into a React
   pane, and can we scroll/highlight to a text position from a search hit?
5. Is there a credible alternative worth naming if pdf.js falls short on any of the
   above in a Node context?

Sources should be primary: the pdf.js API docs and repo, Mozilla examples, the PDF spec
for page labels. Capture findings as a markdown file in the repo and link it back here.

Note: `pdftotext` (poppler) is installed locally and already proven to extract this PDF
cleanly — useful as a ground-truth oracle to check pdf.js output against, but it is not
the shipping dependency.
