# tools

## `probe.mjs` — ingest-viability probe

Reports what throughline's ingest can get out of a candidate book, before committing to it.

```bash
npm i pdfjs-dist          # ^6.2.108, Node >= 22.13
node tools/probe.mjs "path/to/book.pdf"
```

Measures the four things ingest depends on:

| | why it matters |
|---|---|
| `/PageLabels` | resolves `see "X" on page 79` → a PDF page. Only needed for prose citations — outline destinations carry indices directly. |
| bookmark outline | the unit hierarchy, page-resolved for free. Falls back to parsing the printed ToC when absent. |
| text layer | chars/page and empty pages. Near-zero means a scan with no OCR — not ingestible. |
| citation density | how many prerequisite edges the book actually contains. Low means a linear syllabus, not a DAG (#11). |

Plus the font-family split, which separates prose from code listings — Clean Code is 35% monospace, so page extent badly misestimates reading time (#4).

Measured so far:

| | DDIA | Clean Code |
|---|---|---|
| pages | 613 | 462 |
| page labels | ✅ | ❌ |
| outline | 210 nodes / 4 levels | 384 nodes / 3 levels |
| `see "X" on page N` | 320 | 12 |
| `Chapter N` | 431 | 3 |
| monospace share | 1% | 35% |
