# 02 — an interactive page pane

Ticket: https://github.com/acevizli/throughline/issues/16
Researched: 2026-08-07
Method: **empirical, against this repo as it stands** — `next@16.3.0`, `pdfjs-dist@6.2.108`,
`react@19.2.8`, Node v25.2.1, macOS, Chrome. Both options were built as working spikes inside
`app/`, run under `next dev` *and* a real `next build` + `next start`, and measured in a browser.
The spikes were then deleted; only this document and the numbers survive. Where a claim is
reasoned rather than measured it says so.

This revisits [`01-pdfjs-capabilities.md`](01-pdfjs-capabilities.md), whose "Not verified"
section admitted that the whole Next.js story — `serverExternalPackages`, client-side worker
resolution, the bundler failures — was *reasoned from reported bugs, with no Next.js app in the
repo*. There is one now. This replaces that reasoning with measurement, and **contradicts it in
two places**.

---

## Answer

**Take option A: keep the server-rendered PNG exactly as it is and lay a text layer over it,
built from geometry computed server-side and shipped as JSON.** It costs **3,849 bytes** of client
JavaScript, ships **no pdf.js to the browser at all**, and delivers selection, copy, working
internal links and highlight anchors with sub-pixel alignment that holds across the pane's whole
zoom range.

Three findings drive that:

1. **The failure class #2 warned about is gone, but it was never the real cost.** Client-side
   pdf.js builds and runs correctly on Next 16 + Turbopack — the worker resolves, `next build`
   succeeds, pages render. What it costs is **458,646 bytes** of extra client JS plus a
   **2,222,991-byte** worker plus the **24,975,901-byte** PDF, none of which buys anything the
   overlay doesn't already give.

2. **The text layer does not need pdf.js in the browser.** pdf.js's own `TextLayer` positions
   spans in **percentages of the page box**, with size driven by a CSS variable
   (`web/pdf_viewer.css:638-662`). That makes the layer **resolution-independent by construction**:
   it is computed once, in PDF units, and scales with whatever width the `<img>` is given. All of
   that arithmetic runs server-side. Only two things genuinely need a browser — a font ascent
   ratio and a text-width measurement — and both are `canvas.measureText()` calls, about ten lines.

3. **DDIA's cross-references are real link annotations, and they are a better citation source
   than the regex — for sections, not chapters.** Measured across all 613 pages: **8,420** link
   annotations, **6,985** internal, **every one of which resolves to a page index**. Of the 326
   `see "X" on page N` citations in the body, **319 (97.9%) carry their own link**, and **318 of
   those resolve to exactly the page the printed number implies**.

| Fact | Measured |
|---|---|
| Client JS added by the overlay (option A) | **+3,849 bytes** (580,487 → 584,336) |
| Client JS added by client-side pdf.js (option B) | **+458,646 bytes**, plus a 2,222,991-byte worker |
| Overlay geometry, per page | **5.4–10.0 KB**, served in **13–29 ms** warm |
| The PNG it decorates, per page | **632–692 KB**, served in **224–451 ms** |
| Alignment vs pdf.js's own `TextLayer`, zoom 64%–195% | **max 0.102 px** in x, **0.289 px** in y |
| Link annotations in DDIA | **8,420** (6,985 internal, 1,435 external), **0 unresolved** |
| `see "X" on page N` citations carrying their own link | **319 / 326** (97.9%) |
| …whose destination matches the printed page number | **318 / 319** (99.7%) |
| `Chapter N` mentions carrying a link | **171 / 431** (39.7%) |
| Whole-book geometry, if ever precomputed | **4.55 MB**, 2.08 s, 7,779 B/page |

---

## 1. Is the failure class still real? **No.**

### What Next 16 actually does

Next 16 builds with **Turbopack by default**, for `next build` as well as `next dev`; webpack is
now the opt-out, via `--webpack`
(`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:160`). Every measurement
below is Turbopack, because that is what this repo gets by running `npm run build`.

A spike client component doing exactly what `01-pdfjs-capabilities.md` §4 recommends —

```ts
const pdfjs = await import("pdfjs-dist");
pdfjs.GlobalWorkerOptions.workerSrc =
  new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
```

— **works**. `next build` exits 0. The worker is emitted as a static asset and the bare package
specifier inside `new URL(...)` is resolved, which is the thing most likely to have broken:

```
.next/static/media/pdf.worker.290p6ryo_duhj.mjs        2,222,991 bytes
workerSrc resolved to: /_next/static/media/pdf.worker.290p6ryo_duhj.mjs
```

In the browser it loads and handshakes — posting a message to that URL returns
`{"sourceName":"worker","targetName":"main","action":"ready"}` — and pdf.js reports a real worker,
not the in-process fake one. Page 100 of DDIA rendered to canvas with a 57-span `TextLayer` over
it, in dev and in a production `next start`. **None of #2's predicted failures reproduced**: no
Terser error on `.mjs`, no unresolvable worker, no missing dynamic-import target.

### The one real Next-specific wart

Turbopack emits a warning, and only when client-side pdf.js is present (measured: 0 occurrences in
the baseline build, 0 in the overlay-only build, 1 in the build containing the client spike):

```
./app/spike-client
Warning: Package pdfjs-dist can't be external
The request pdfjs-dist/build/pdf.worker.mjs matches serverExternalPackages (or the default list).
The package seems invalid. require() resolves to a EcmaScript module, which would result in an
error in Node.js.
```

`serverExternalPackages: ["pdfjs-dist"]` in `next.config.ts` is matched against the *client* worker
request too. It is a warning, the worker is emitted correctly anyway, and the build succeeds — but
it is the residue of the failure class, and it would have to be lived with or worked around
(a relative path into `node_modules`, or a copy in `public/`) if option B were ever taken.

### A hazard worth recording, because it cost an hour

`page.render()` **hangs forever, silently, with no error and no network activity, in a
backgrounded tab.** pdf.js's render loop continues via `requestAnimationFrame`, which browsers do
not fire when `document.visibilityState === "hidden"`. Reproduced identically on a plain static
HTML page served from `public/` with no Next.js involved, which is how it was ruled out as a
framework problem; the render completed the instant the tab was brought to the front (78,590 ms
after it started). **This is an artefact of automating a hidden tab, not a defect** — but anything
that renders pdf.js off-screen, in a hidden tab, or in a headless harness will appear to deadlock.
Server-side rendering has no such failure mode, which is a small extra point for option A.

---

## 2. Can the text layer be an overlay? **Yes, and it needs no pdf.js in the browser.**

### Why this works: pdf.js's own layer is already resolution-independent

Read from the shipped `build/pdf.mjs`, `TextLayer#appendText` (lines 15004–15025):

```js
const tx = Util.transform(this.#transform, geom.transform);   // #transform = [1,0,0,-1,-pageX, pageY+pageHeight]  (:14877)
const fontHeight = Math.hypot(tx[2], tx[3]);
const fontAscent = fontHeight * TextLayer.#getAscent(fontFamily, style, lang);
divStyle.left = `${(100 * left / this.#pageWidth).toFixed(2)}%`;
divStyle.top  = `${(100 * top  / this.#pageHeight).toFixed(2)}%`;
divStyle.setProperty("--font-height", `${fontHeight.toFixed(2)}px`);
```

and the CSS that consumes it (`web/pdf_viewer.css:648-662`):

```css
--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
font-size: calc(var(--text-scale-factor) * var(--font-height));
transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
```

Positions are **percentages** and sizes are **PDF units times one scalar**. Nothing in the layer
knows the render's pixel scale. `--total-scale-factor` is just `renderedWidthPx / pdfPageWidth`.

That is the whole finding: **the text layer was never coupled to the canvas.** It is coupled to the
page *box*. A server-rendered PNG of the same page box is as valid a backdrop as a client-rendered
canvas.

### What has to happen in the browser, and what doesn't

Everything above — the transform, the percentages, the font height — is arithmetic over
`getTextContent()` output and runs fine in a route handler. Two things cannot:

- **`--font-height`'s ascent ratio.** `TextLayer.#getAscent` (`build/pdf.mjs:15146`) measures
  `fontBoundingBoxAscent / (ascent + descent)` from a canvas, falling back to `0.8`. It depends on
  the *browser's* substituted font, so it must be measured there. Cached per family — DDIA uses two.
- **`--scale-x`.** `TextLayer#layout` (`:15062`) calls `ctx.measureText()` and scales the span
  horizontally so its rendered width matches the PDF's. Also a browser font metric.

Both are `canvas.getContext("2d").measureText()`. Neither needs pdf.js.

### Geometry from a route handler, not the client — and why

The spike served geometry from `/api/spike-text?book=…&page=N`, and that is the right seam. The
server already holds the book open (`Pages` in `src/pdf/book.ts`, cached for the server's life by
`lib/library.ts`), already has pdf.js loaded, and already renders the PNG from that same document.
Fetching it client-side would mean shipping pdf.js *and* the 24 MB PDF to get numbers the server
can produce in 13 ms. Measured, production, warm:

```
$ for p in 150 151 152 300 450; do curl -o /dev/null -w "page $p: %{time_total}s %{size_download}b\n" \
    "http://localhost:3000/api/spike-text?book=$B&page=$p"; done
page 150: 0.023712s 6385b     page 300: 0.013312s 5480b
page 151: 0.016156s 8015b     page 450: 0.012975s 9987b
page 152: 0.028676s 5395b

# the PNG it decorates, same server, same pages:
page 150 scale3: 0.450613s 631777b
page 151 scale3: 0.223598s 691601b
```

**The geometry is ~15× faster and ~70× smaller than the render it sits on.** It is also
`immutable`-cacheable on exactly the same terms as the PNG, and — unlike the PNG — it does not vary
with scale, so one response serves every zoom level.

### Alignment: measured against pdf.js's own layer

The check is not "does it look right". The spike built pdf.js's **real `TextLayer`** for the same
page at the same rendered width in a hidden container and diffed `getBoundingClientRect()` span by
span against the server-driven overlay, at six zoom levels spanning all three whole-step server
scales:

| zoom | CSS width | server `scale` | items | max Δx | max Δy |
|---|---|---|---|---|---|
| 64% | 550 px | 2 | 52 | 0.031 px | 0.039 px |
| 80% | 688 px | 2 | 52 | 0.039 px | 0.047 px |
| 100% | 860 px | 3 | 52 | 0.055 px | 0.289 px |
| 125% | 1075 px | 4 | 52 | 0.063 px | 0.070 px |
| 156% | 1344 px | 4 | 52 | 0.078 px | 0.094 px |
| 195% | 1680 px | 4 | 52 | 0.102 px | 0.117 px |

Sub-pixel throughout, and the residual is explained: percentages are rounded to 3 decimals and the
ascent to 2. **Crossing a server-scale step changes nothing**, because the overlay never sees the
PNG's pixel scale — only the CSS width. The zoom model in `app/page.tsx` (measured column ×
`zoom`, whole-step `Math.min(4, Math.max(2, Math.ceil((width * dpr) / 700)))`) therefore survives
untouched. Visually confirmed by tinting the layer red over the PNG at 156% / scale 4:
`…/scratchpad/spike/overlay-alignment-156pct.jpg` (scratchpad — will not survive).

### Selection, copy and reading order

Selecting across four rendered lines of page 100 returned, verbatim:

```
Maintaining a sorted structure on disk is possible (see “B-Trees” on page 79), but
maintaining it in memory is much easier. There are plenty of well-known tree data
structures that you can use, such as red-black trees or AVL trees [2]. With these data
structures, you can insert keys in any order and read them back in sorted order.
```

Correct order, correct line breaks, curly quotes intact.

**One trap, found by getting it wrong first.** pdf.js appends a `<br>` after *any* item with
`hasEOL` — including items that have text (`build/pdf.mjs:15057`). The first spike only emitted
`<br>` for the empty line-break marker items, and copied text came out as `butmaintaining`,
`datastructures`. It is a one-line fix, but it is invisible on screen and only shows up in the
clipboard, so it will be re-introduced by anyone who reimplements this from the geometry alone.

Page changes work: stepping the spike's page window re-fetched geometry and links and re-rendered
the layer against the new PNGs, with no leakage between pages.

---

## 3. Are the book's internal links reachable? **Yes — and they beat the regex for sections.**

Census over all 613 pages of DDIA (4.58 s, `getAnnotations()` + `getDestination()` +
`getPageIndex()`):

```
Link annotations         8,420        pages carrying links     558 / 613
  internal               6,985        distinct destinations  5,623
  external (URL)         1,435        unresolved                 0
```

**Every internal link resolves.** Destinations are *named* strings — `sec_storage_b_trees`,
`ch_storage`, `Cormen2009uw` — and `doc.getDestination(name)` → `doc.getPageIndex(ref)` returned a
page for all 6,985 of them.

### The destination name classifies the edge, which is the useful part

| destination shape | count | what it is |
|---|---|---|
| `idm…` | 3,152 | index-term anchors |
| author-year (`Cormen2009uw`) | 1,857 | bibliography references — the `[2]`, `[6]` markers |
| **`sec_…`** | **895** | **section cross-references** (137 in the ToC, **758 in the body**; 227 distinct) |
| `fig_`/`tbl_`… | 261 | figures and tables |
| **`ch_…`** | **210** | **chapter cross-references** |

So the graph #5 wants is not "internal links" — 83% of those are index and bibliography plumbing —
it is the `sec_*` and `ch_*` subset. That subset is identifiable **by name, mechanically**, with no
prose parsing.

### Head to head with the regex

| | regex (`tools/probe.mjs`) | annotations |
|---|---|---|
| `see "X" on page N` | 320 | **319 of 326 carry their own `sec_` link (97.9%)** |
| …target correct | needs `getPageLabels()` lookup | **318 / 319 agree with it (99.7%)**, no lookup needed |
| section cross-refs found in the body | 320 | **758** |
| `Chapter N` | 431 | **171 of 431 carry a link (39.7%)**; 210 `ch_` links total |

Two things to say plainly.

**For section citations, annotations are strictly better.** They find **758** body cross-references
against the regex's 320 — the regex only sees the `see "…" on page N` phrasing, while the PDF links
every reference however it is worded. They carry the destination directly, so the whole
`getPageLabels()` printed→index step is unnecessary for these edges. They are immune to the two
gotchas `01-pdfjs-capabilities.md` §1 records: **soft hyphens** (`see "Maintainabil‐ity" on page
18` links correctly *because* the link is on the glyphs, not the string) and **join sensitivity**
(this pass counted 326 precise citations where `probe.mjs` counts 320 — the difference is only
whether whitespace-only text items are dropped before joining; the annotation count has no such
knob). And they de-duplicate for free: 326 citation instances collapse to **152 distinct `sec_`
targets** and **311 distinct page→page edges**, because the same section cited twice is the same
named destination, not two strings to normalise.

**For chapter references, annotations are worse.** Only 171 of 431 `Chapter N` mentions are
hyperlinked. The regex finds 2.5× more. If chapter-level edges matter, keep the regex for those.

The honest recommendation for #5 is **hybrid**: `sec_*` annotations for precise section edges,
regex for `Chapter N`. The one measured disagreement between an annotation and its printed page
number (page 351, `see "Actual Serial Execution" on page 252` → the link resolves to 279, the label
says 274) is more likely my overlap heuristic picking the neighbouring `sec_transactions_2pl` link
on the same line than an error in the book; it was not chased down.

### Clicking one navigates the pane

The spike drew each link's `rect` as a percentage-positioned `<a>` over the PNG. On page 100 all
seven resolved, boxes landed exactly on the anchor text, and clicking `sec_storage_b_trees` scrolled
the pane 1,863 px to page 101 — the page `getPageLabels()` also gives for printed page 79. So the
click path is an `href="#page-N"` against the ids `app/page.tsx` already renders.

### This does not generalise, and that is fine

Clean Code, the adversarial book from #10, has 2,503 link annotations of which only 716 resolve
(1,751 carry no destination at all) and — decisively — **zero named destinations**. Every one is a
raw array dest, so there is no `sec_`/`ch_` discriminator and no way to tell a cross-reference from
a ToC back-link. DDIA's names come from its O'Reilly/AsciiDoc toolchain, not from PDF.

This is exactly the shape #11's capability profile exists for: **"carries named `sec_`/`ch_`
destinations" is a measurable per-book capability**, cheap to probe, and the citation source should
be chosen from it rather than assumed. The *text layer overlay*, by contrast, needs only a text
layer, so it works on both books.

---

## 4. What does each option cost?

Measured with `next build` (Turbopack) and `next start`, client JS summed over `.next/static`:

| | **A — PNG + overlay** | **B — client pdf.js** | **C — status quo** |
|---|---|---|---|
| Client JS added | **+3,849 B** | **+458,646 B** (452,041 B of it one pdfjs chunk, 133,565 B over the wire) | 0 |
| Worker asset | none | **2,222,991 B** raw, 475,432 B over the wire, **unminified** — Turbopack copies `pdf.worker.mjs` verbatim, not `.min.mjs` | none |
| PDF to the browser | none | **24,975,901 B** — the whole file; the spike route serves no ranges | none |
| Per page over the wire | PNG (632–692 KB) + geometry (5.4–10 KB) | canvas drawn locally; no PNG | PNG only |
| First paint | unchanged — the `<img>` is the same request; the layer arrives 13–29 ms later and is invisible until then | blocked on worker + 24 MB PDF; 1,105 ms to open the document in production, cold | unchanged |
| Page change | one cached JSON fetch | `getPage` + render, 33 ms warm | free |
| Zoom | **percentages; nothing recomputed**. Verified 64–195% across server scales 2/3/4 | `TextLayer.update({viewport})` per zoom step | free |
| Renders off-screen / hidden tab | fine (server-side) | **hangs** (see §1) | fine |
| Code | one route handler (~90 lines) + ~60 lines of client layer | replace the render path; `next.config.ts` warning to work around | none |
| Selection / copy / links / highlight anchors | **yes** | yes | **no** |

Option B's totals in a real production load: **748,514 bytes transferred** of JS and worker before
the 24 MB PDF, against option A's **3,849 bytes** of JS and ~8 KB per page.

**Option B buys nothing option A doesn't have.** Its only structural advantage would be rendering
without a round-trip per page — but the PNGs are already `immutable`-cached and rendered in 224–451
ms server-side, and the pane is a reading surface, not a scrubber.

### Should the geometry be precomputed at ingest?

**No.** Computing it for all 613 pages takes 2.08 s but produces **4.55 MB** (7,779 B/page), which
would go into `~/.throughline/throughline.db` per book. On-demand costs 13–29 ms and caches in the
browser on the same `immutable` terms as the PNG. Nothing to persist. (This mirrors #9's reasoning
for deferring persistence at 2.5 s.)

---

## Recommendation

**Option A. Keep `Pages.render()` and the `<img>` exactly as they are; add a geometry route and a
text-layer overlay.**

Concretely:

- A route handler beside `app/api/page/route.ts` returning, per page: the page box, one entry per
  text item (`str`, baseline x/y in PDF units, font height, width, generic family, `dir`, `hasEOL`),
  and each link annotation's rect as fractions plus its resolved target page and destination name.
  It should read from the **same `Pages` instance** `lib/library.ts` already caches, rather than
  opening its own document as the spike did — that is the only structural thing the spike got wrong.
- A client layer that positions spans at the server's percentages, sizes them by
  `renderedWidth / pageWidth × fontHeight`, and finishes the two browser-only metrics (ascent
  ratio, `scaleX`) with `canvas.measureText()`. **Emit a `<br>` after every item with `hasEOL`**,
  text or not.
- Links as absolutely-positioned `<a href="#page-N">` over the same box.
- **Do not** add pdf.js to the client. **Do not** change `next.config.ts` — `serverExternalPackages`
  is correct and only misfires for client-side pdf.js, which this does not use.

The comment in `src/pdf/book.ts` on `Pages.render` — *"The cost is no selectable text layer in the
viewer … the coordinate work for highlighting can move client-side later without changing the
ingest half"* — turns out to be right, and cheaper than it expected: the coordinate work does not
have to move client-side at all.

### Consequences for the map

1. **#2's "no client-side pdf.js in Next" warning is superseded, but the conclusion still stands
   for a different reason.** The failure class does not reproduce on Next 16 + Turbopack. Client-side
   pdf.js is rejected here on **cost**, not on breakage. Anyone who reopens this should know it
   would *work*.
2. **#8's stated trade — server PNG *at the cost of* a selectable text layer — was a false
   dichotomy.** The text layer is coupled to the page box, not to the canvas. Both are available.
3. **#5 should take `sec_*` link annotations as its primary source for section edges** — 758 in the
   body against the regex's 320, targets pre-resolved, no `getPageLabels()` lookup, no
   de-hyphenation, de-duplicated by destination name — and **keep the regex for `Chapter N`**,
   where annotations cover only 40%.
4. **#11 gains a capability to measure:** *does this book carry named `sec_`/`ch_` destinations?*
   DDIA does, Clean Code does not. Cheap to add to `tools/probe.mjs`.
5. **#17 "notes anchored to the book" is unblocked, and its anchor should be a character range,
   not a coordinate.** The overlay gives a real DOM `Selection`, so a note anchors as
   `(page, itemIndex, startOffset, endOffset)` — item indices are exactly the `getTextContent()`
   indices ingest already sees, which is the same bridge `01-pdfjs-capabilities.md` §4 identified
   via `textDivs`. Rendering a highlight is then a box per item from geometry the route already
   returns, in percentages, so highlights survive zoom for free. **No coordinate persistence, and
   nothing to re-derive if the render path ever changes.**

---

## Not verified

- **Other books' text layers.** Alignment was measured on DDIA pages 100–105 only, and the
  reading-order claim inherits `01-pdfjs-capabilities.md`'s open question — content-stream order
  matched visual order on the pages sampled, but that is a producer property. **Multi-column,
  rotated, or figure-heavy pages were not tested at all**, and `angle !== 0` items exist in the
  geometry shape but were never exercised.
- **Vertical text.** `TextStyle.vertical` is handled by pdf.js (`angle += π/2`) and the spike
  carried the field through, but no vertical-script PDF was tested.
- **The overlay inside the real `Reader`.** The spike reproduced the zoom/fit model
  (measured column, `zoom` multiplier, whole-step server scale) but is not the real component.
  In particular the real pane's `loading="lazy"` images, its `ResizeObserver`, and focus mode were
  not exercised with a layer attached. The spike also hydration-errored on its own SSR'd sticky bar
  because `devicePixelRatio` differs between server and client — an artefact of the spike being a
  static route, but a reminder that anything dpr-derived must not render during SSR.
- **Selection *across* page boundaries.** Selection was tested within one page. Dragging from one
  page's layer into the next is the interesting case for #17 and was not tried.
- **Text-layer cost at unit scale.** A unit can span dozens of pages; only two-page windows were
  rendered. 40,192 items across 613 pages averages 66 spans/page, so a 40-page unit is ~2,600
  absolutely-positioned spans — probably fine, **not measured**.
- **The one annotation/label disagreement** (page 351) was not chased to a root cause.
- **`getAnnotations()` on a book with no annotations** — neither test book lacks them entirely.
- **Range requests for option B.** The spike route served the whole 24 MB PDF; pdf.js can do range
  requests against a server that advertises them, which would change option B's first-paint number
  (not its bundle numbers). Since option B is rejected on bundle size, this was not pursued.
- **Non-Chrome browsers.** All browser measurements are Chrome on macOS. `fontBoundingBoxAscent` is
  the metric pdf.js itself warns about on Firefox (`build/pdf.mjs:15165` advises enabling
  `dom.textMetrics.fontBoundingBox.enabled`), so ascent — and therefore vertical alignment — may
  differ there. Irrelevant while this is a local app, but it is the first thing to check if the
  layer ever looks a line off.

---

## Reproducing

Spike code was deleted with the working tree left clean. Scratch scripts and captured output are in
the session scratchpad, which will not survive:

`/private/tmp/claude-501/-Users-kobil-ReadHelper/f9a8ff98-6565-4c06-a25c-082b5c7fbd51/scratchpad/spike/`
— `annots.mjs` full-book annotation census, `cite2.mjs` citation↔annotation coverage and
destination-kind counts, `kinds.mjs` destination-name shapes, `geosize.mjs` whole-book geometry
cost, `build-*.txt` the three build logs the bundle deltas came from,
`overlay-alignment-156pct.jpg` the tinted-overlay screenshot.

Bundle numbers are `find .next/static -name "*.js" | xargs stat -f "%z" | awk '{s+=$1} END {print s}'`
after `rm -rf .next && npx next build`, with the spike routes present and absent. Alignment numbers
came from building pdf.js's real `TextLayer` in a hidden container in the page and diffing
`getBoundingClientRect()` per span; the annotation counts are reproducible against any copy of the
pilot PDF with the scripts above.
