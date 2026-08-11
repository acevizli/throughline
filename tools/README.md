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

## `rag-probe.mjs` — retrieval probe

Does semantic search over this book return the right passages? Chunks a page range,
embeds it with Voyage, and ranks queries against it.

```bash
node tools/rag-probe.mjs "path/to/book.pdf" --from 69 --to 110 \
  --query "writes are appended to a log, and the log is compacted in the background"
```

`--from`/`--to` are **printed** page numbers, resolved through `/PageLabels`; omit them for
the whole book. `--size` (default 900) and `--overlap` (default 0.25) tune the window.
Needs `VOYAGE_API_KEY` in `.env`. With no `--query` it stops before the API call, which is
the quick way to check the chunking alone.

Chunking here is deliberately naive — a repaired text stream cut into overlapping
sentence-snapped windows, with no paragraph detection and no layout analysis. That was
[measured](https://github.com/acevizli/throughline/issues/26) against per-paragraph
chunking and won. The stream repairs are the part that matters: a space where the font
changes (`asfractal` → `as fractal`), a hyphen rejoined across a line break
(`imple‐ mentation` → `implementation`), recurring page furniture dropped, and monospace
excluded.

This is the gate on [#23](https://github.com/acevizli/throughline/issues/23). Numbers to
beat, DDIA Chapter 3 (printed 69–110), `voyage-4`:

| query | expected |
|---|---|
| answer is in the slice | 0.616 – 0.661 |
| answer is *not* in the slice | 0.236 ceiling |
| `"the branching factor is typically several hundred"` | 0.434, right answer ranked 2nd |

Pacing note: the free tier's binding limit is **10K tokens/min**, not the 3 requests/min and
not the 1,000-texts-per-request cap. One batch of 125 chunks returns 429, so the probe
splits into requests a minute apart — 40 pages takes ~5 minutes.
