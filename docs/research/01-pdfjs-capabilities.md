# 01 — pdf.js extraction capabilities

Ticket: https://github.com/acevizli/throughline/issues/2
Researched: 2026-08-05
Method: pdf.js API/type/source inspection **plus empirical runs against the pilot PDF**
(`pdfjs-dist@6.2.108`, Node v25.2.1, macOS). Every numeric claim below was measured, not quoted.

---

## Answer

**Yes — pdf.js alone covers both halves, and the coordinates provably agree.** Ingest and viewer can
share one dependency, one page-coordinate space, and one version.

Three findings change the plan materially:

1. **This PDF *does* carry `/PageLabels`, and pdf.js reads it.** `getPageLabels()` returns a
   613-entry array: `["Cover","BackCover","i","ii",…,"xx","1","2","3",…,"591"]`. Printed page 3 is
   array index 24 → **1-based PDF page 25**, which is exactly where Chapter 1 sits. The
   printed→index mapping is **free and exact**. No offset inference, no footer scraping, no
   heuristics. For the arabic body: `pdfPage1Based = printedPage + 22`, but do not hardcode that —
   just index the array.

2. **The map is wrong that there is no bookmark outline.** `getOutline()` returns a **210-node,
   4-level tree**: Part → Chapter → H2 → H3, with destinations that resolve to exact pages
   (`"Chapter 1. Reliable, Scalable, and Maintainable Applications"` → pdf 25 / printed 3;
   `"Hardware Faults"` → pdf 29 / printed 7). The full unit hierarchy is available **structurally**,
   without parsing the printed ToC text at all. `Tagged: no` refers to accessibility
   *structure tagging*, not bookmarks — the two are unrelated, and the map conflated them.

3. **Coordinate agreement is proven, not assumed.** Rendering page 101 server-side and drawing the
   box implied by the extracted `transform` of the `"B-Trees"` item landed pixel-accurately on the
   heading (screenshot verified). `Util.transform(viewport.transform, item.transform)` is the exact
   mapping from extraction space to render space.

Supporting measurements:

| Fact | Measured |
|---|---|
| Full-document text extraction, 613 pages, headless Node | **1.94 s** (3.2 ms/page), 40,192 items, 1.39 M chars |
| Server-side render of one page @ scale 2 (1008×1323) | **185 ms** |
| `see "X" on page N` citations found across whole book | **238** |
| `Chapter N` citations found across whole book | **425** |
| Bottom-most text item equals the printed page label | **564 / 573** arabic pages (98.4%) |
| DOM globals required for text extraction | **none** (`document`/`window`/`DOMMatrix` all undefined) |

Caveats that will bite if ignored: `fontName` is an **unstable alias**, there is **no bold/weight
field**, extracted strings contain **U+2010 soft hyphens mid-word**, and pdfjs-dist v6 is
**ESM-only** while `react-pdf` still pins v5.

---

## 1. `getTextContent()` — what you actually get

### Per-item shape (verified against shipped `types/src/display/api.d.ts:312`)

```ts
type TextItem = {
  str: string;         // text content
  dir: string;         // 'ttb' | 'ltr' | 'rtl'
  transform: number[]; // [a,b,c,d,e,f] — e,f are x,y of the BASELINE origin, PDF space (y-up)
  width: number;       // device space
  height: number;      // device space — effectively the font size at scale 1
  fontName: string;    // alias into TextContent.styles — NOT the real font name
  hasEOL: boolean;     // a line break follows
};

type TextStyle = { ascent: number; descent: number; vertical: boolean; fontFamily: string };
```

`getTextContent(params?)` accepts exactly two options
(`types/src/display/api.d.ts:275`): `includeMarkedContent` (default `false`) and
`disableNormalization` (default `false`). Nothing else.

Note what is **absent**: no `fontSize`, no `fontWeight`/`bold`, no color, no `pageNumber`. Font size
comes from `height` (or `transform[0]`/`transform[3]`, identical here). Weight does not come from
this API at all.

Real observed item from page 25:

```json
{"str":"CHAPTER 1","dir":"ltr","width":59.15,"height":16.82,
 "transform":[16.82,0,0,16.82,372.84,569.71],"fontName":"g_d0_f1","hasEOL":false}
```

### (a) Detecting a printed page number in a header/footer — **yes, easily**

Text items carry absolute page coordinates, so the footer is just the minimum-`transform[5]` band.
Measured on page 25 (printed 3), the single bottom-most item at `y=42.8` is literally `"3"`. On
verso pages the band is `"4" | "Chapter 1: Reliable, Scalable, and Maintainable Applications"`; on
recto pages `"Reliability" | "9"`. Across all 573 arabic-labelled pages the bottom band contains the
page label 98.4% of the time.

**But you should not need this.** `getPageLabels()` (§2) gives the same mapping exactly and for
100% of pages, including the roman front matter where footer scraping is weakest. Keep footer
detection only as a cross-check oracle, not as the mechanism.

### (b) Inferring heading level from font size/weight — **size yes, weight only via a detour**

Size is clean and discrete. Measured ladder on real pages:

| `height` | Font (resolved) | Role |
|---|---|---|
| 25.22 | MyriadPro-SemiboldCond | Chapter title |
| 18.92 / 16.82 | MyriadPro-SemiboldCond | Part / `CHAPTER n` label |
| 15.77 | MyriadPro-SemiboldCond | H2 (`"B-Trees"`) |
| 11.56 | MyriadPro-SemiboldCond | H3 (`"Performance optimizations"`) |
| 10.5 | MinionPro-Regular / -It | Body / emphasis |
| 9 | MyriadPro-SemiboldCond | Running head/foot |

Headings are sans-serif, body is serif, so `styles[fontName].fontFamily === 'sans-serif'` plus the
height ladder separates headings from body **without** needing weight.

**Weight/style is not in `getTextContent()`.** `TextStyle` only exposes generic
`fontFamily: 'serif' | 'sans-serif'`. To get the real PostScript name you must call
`page.getOperatorList()` first (to populate `commonObjs`), then `page.commonObjs.get(item.fontName)`,
which yields `{ name: "ERUTAY+MyriadPro-SemiboldCond", loadedName, fallbackName }`. Verified working
headless. Two warnings:

- The returned object's own keys are only `compiledGlyphs, _inspectFont, attached` — `bold`/`italic`
  are `undefined`. You must **string-parse the `name`** (`/Semibold|Bold|Black|-It/`).
- `getOperatorList()` is far more expensive than `getTextContent()`. Since the size+family ladder
  already suffices here, treat the real-name lookup as a one-off calibration step, not a per-page cost.

### Gotcha A — `fontName` is an unstable, load-order-dependent alias

The alias format is `g_d{documentIndex}_f{n}`, assigned **in the order fonts are first encountered
across the document session**. Demonstrated:

```
page 101 loaded ALONE            : g_d0_f1 = MinionPro-Regular,      g_d0_f3 = MyriadPro-SemiboldCond
page 101 loaded AFTER page 25    : g_d1_f1 = MyriadPro-SemiboldCond, g_d1_f3 = MinionPro-Regular
```

Same page, same PDF, opposite meaning — and the `d0`→`d1` prefix increments on every `getDocument()`
call in the process, so in a long-lived Next.js server the aliases drift continuously.
**Never persist `fontName` to SQLite, never compare it across pages processed in different batches,
never hardcode it.** Resolve it to `fontFamily` or the real name *within the same load session* and
store that instead. This is the single most likely source of a silent ingest bug.

### Gotcha B — soft hyphens inside extracted strings

Line-broken words retain U+2010: harvested citations include `see "Maintainabil‐ity" on page 18` and
`see "Rebalancing Parti‐tions" on page 209`. Since citation targets must be matched against ToC/outline
titles, **strip `‐` and `­` and rejoin before matching**, or those edges silently fail to
resolve. (`disableNormalization: false`, the default, does not remove these.)

### Gotcha C — empty items and reading order

`items` includes zero-width entries (`{"str":"","width":0,"height":0,"hasEOL":true}`) used purely as
line-break markers. Filter on `str.trim()` before geometry work. Items arrive in PDF content-stream
order, which matched visual reading order throughout the sampled pages of this book, but that is a
property of this producer, not a guarantee — sort by `(-y, x)` if you need certainty.

---

## 2. Page labels — and the concrete answer for *this* file

### API contract

`PDFDocumentProxy.getPageLabels(): Promise<string[] | null>`. From the worker source
(`legacy/build/pdf.worker.mjs`, `#readPageLabels`): if the catalog has no `/PageLabels` it returns
`null` outright; on a malformed dictionary it logs `"Unable to read page labels."` and also yields
`null`. So `null` is the no-labels signal and the array, when present, always has exactly `numPages`
entries. Handle `null` — do not assume the array exists.

### Does *this* PDF carry one? **Yes.**

`pdfinfo` prints no page-label section, which is misleading — poppler's `pdfinfo` does not report
labels at all, so its silence is not evidence. Inspecting the catalog directly settles it.

The file has been **incrementally updated** (three `trailer`s, `/Prev` chains), and it contains two
different catalogs. The superseded one carries a near-useless inline dictionary:

```
/PageLabels << /Nums [ 0 << /S /D >> 20 << /S /D >> ] >>
```

The **current** catalog (object 17719 at byte offset 24971105, reached via the last trailer's
`/Root`) points at a proper one:

```
17719 0 obj <</Lang(EN)/Metadata 17820 0 R/Names 17720 0 R/OpenAction 17889 0 R
             /Outlines 17245 0 R/PageLabels 17821 0 R … /Type/Catalog>>

17821 0 obj <</Nums[0 17885 0 R  1 17886 0 R  2 17887 0 R  22 17888 0 R]>>
  17885 = <</P(Cover)>>      17886 = <</P(BackCover)>>
  17887 = <</S/r>>           17888 = <</S/D>>
```

Read against the PDF spec's page-label rules (ISO 32000-1 §12.4.2, `/S` numbering style, `/P` prefix,
`/St` start — absent here so each range starts at 1): index 0 = `"Cover"`, index 1 = `"BackCover"`,
indices 2–21 = lowercase roman `i`–`xx`, index 22 onward = decimal from `1`.

**Anything reading only the older catalog gets the wrong answer.** A naive `grep`/regex parser that
takes the first `/PageLabels` it finds will read the superseded inline dictionary and produce
labels `1,2,…` from index 0 with a restart at 20 — off by 22 and missing the roman section entirely.
pdf.js follows the xref chain correctly and reads the current one.

### Verified output

```
getPageLabels() -> Array(613)
  [0..29]  Cover, BackCover, i, ii, iii, iv, v, vi, vii, viii, ix, x, xi, xii, xiii,
           xiv, xv, xvi, xvii, xviii, xix, xx, 1, 2, 3, 4, 5, 6, 7, 8
  label "3"  -> index 24  -> 1-based PDF page 25
  label "79" -> index 100 -> 1-based PDF page 101
  last 5: 587, 588, 589, 590, 591
```

Cross-checked against content: PDF page 25 is the Chapter 1 opener and its footer prints `3`; PDF
page 101 is the `"B-Trees"` section and its footer prints
`Data Structures That Power Your Database | 79`. The ticket's `see "B-Trees" on page 79` example
therefore resolves end-to-end — the citation appears on PDF page 100, and label lookup sends it to
PDF page 101, where `"B-Trees"` is an H2 at `height=15.77`. **The prerequisite-graph resolution
mechanism is confirmed working on real data.**

### Bonus: the outline the map says doesn't exist

`getOutline()` returns 10 top-level nodes, **210 nodes total**, depth 4
(`{depth1: 10, depth2: 19, depth3: 54, depth4: 127}`):

```
Part I. Foundations of Data Systems                       -> pdf 23 / printed 1
  Chapter 1. Reliable, Scalable, and Maintainable Apps    -> pdf 25 / printed 3
    Thinking About Data Systems                           -> pdf 26 / printed 4
    Reliability                                           -> pdf 28 / printed 6
      Hardware Faults                                     -> pdf 29 / printed 7
      Software Errors                                     -> pdf 30 / printed 8
    Scalability                                           -> pdf 32 / printed 10
      Describing Load                                     -> pdf 33 / printed 11
```

Destinations resolve via `doc.getDestination(dest)` (for named dests) then `doc.getPageIndex(ref)`.
This is the same Part→Chapter→H2→H3 hierarchy the map planned to recover by parsing printed ToC text,
available structurally and already page-resolved. **Recommend re-scoping the ToC-parsing work to use
the outline as primary and the printed ToC only as a validation cross-check.**

Sources: [PDF 1.7 / ISO 32000-1 §12.4.2 Page Labels](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf),
[`PDFDocumentProxy` API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html),
worker source `#readPageLabels` in the installed `pdfjs-dist@6.2.108`.

---

## 3. Server-side in a Node / Next.js route handler

### Version and shape

`pdfjs-dist@6.2.108` (build `0365cbde0`) is current. From its `package.json`:

```json
{ "main": "build/pdf.mjs",
  "types": "types/src/pdf.d.ts",
  "engines": { "node": ">=22.13.0 || >=24" },
  "optionalDependencies": { "@napi-rs/canvas": "^1.0.0" } }
```

**Node ≥22.13 is a hard engine requirement.** There is **no CJS build anywhere** — `build/` and
`legacy/build/` contain only `.mjs`. The v3-era UMD `pdf.js` file is gone.

### Which build

Use **`pdfjs-dist/legacy/build/pdf.mjs`**. Measured: text extraction succeeds from the legacy build,
the modern `build/pdf.mjs`, and the bare `pdfjs-dist` specifier alike — but the two non-legacy paths
emit `Warning: Please use the 'legacy' build in Node.js environments.`, and the modern build reaches
for DOM APIs on the rendering path. Confirmed failure mode:

```
$ node -e "require('pdfjs-dist')"
Warning: Please use the `legacy` build in Node.js environments.
DOMMatrix is not defined
```

Node 25 permits `require()` of ESM, so you do **not** get `ERR_REQUIRE_ESM` — you get the far more
confusing `DOMMatrix is not defined` instead, because bare `require` resolves `main` to the *modern*
build. Import the legacy path explicitly and the problem disappears.

### Worker configuration — nothing to do

`GlobalWorkerOptions.workerSrc` defaults to `"./pdf.worker.mjs"` and **was never set** in any of the
runs above. pdf.js falls back to an in-process "fake worker" in Node and everything works: 613 pages
parsed in 1.94 s. Do not fight Next.js's bundler trying to emit a worker file for the server side —
on the server you simply don't need one. (The *client* viewer does; see §4.)

### DOM

None required for extraction — verified `document`, `window`, `DOMMatrix`, `Path2D` all `undefined`
at the point of a successful 613-page extraction. Text extraction is fully headless.

### Canvas

`@napi-rs/canvas` is an **optional dependency and installs automatically** (1.0.3 present after a
plain `npm install pdfjs-dist`). It is needed only to *render*; extraction never touches it. This is a
real improvement over the old `node-canvas` situation — no Cairo, no node-gyp, prebuilt Skia binaries.
Server-side rendering verified working (§5).

### Next.js specifics

Add to `next.config.ts`:

```ts
const nextConfig = { serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"] };
```

This keeps both out of the server bundle and lets Node resolve them natively at runtime, which avoids
the whole class of reported failures — worker files not resolving, Terser choking on `import`/`export`
in `.mjs`, and dynamic-import targets being missed by the standalone-output file tracer. `@napi-rs/canvas`
in particular ships platform-specific `.node` binaries that **must not** be bundled.

Also: the package ships `wasm/` (jbig2, openjpeg, qcms, quickjs), `iccs/`, 169 `cmaps/` and 16
`standard_fonts/` files, all loaded at runtime via paths rather than static imports. Marking the
package external is what keeps these reachable. If you ever hit blank or mojibake text on a *different*
book, pass `cMapUrl`/`standardFontDataUrl` pointing into `node_modules/pdfjs-dist/`. Not needed for
DDIA — its fonts are embedded and extraction is clean.

### Recent breaking changes worth knowing

- **ESM-only, `.mjs` worker** (from v4). CJS consumers must use dynamic `import()`.
- **`renderTextLayer()` removed.** Verified: the export is `undefined` in v6; the `TextLayer` class
  replaces it.
- **`page.render()` now wants an explicit `canvas`** alongside `canvasContext` and `viewport`.
- **`Promise.withResolvers` used internally** — part of why the Node floor is 22.13.
- **`@napi-rs/canvas` replaced `canvas`** as the Node rendering backend.

Sources: [pdf.js repo](https://github.com/mozilla/pdf.js),
[migrating to v4 discussion](https://github.com/mozilla/pdf.js/discussions/17989),
[legacy build in bundlers](https://github.com/mozilla/pdf.js/discussions/18300),
[Next.js worker/Terser build failure](https://github.com/vercel/next.js/discussions/61549),
[Next.js pdfjs-dist import issue](https://github.com/vercel/next.js/issues/58313),
installed `pdfjs-dist@6.2.108` package metadata and sources.

---

## 4. Rendering a page into React, and highlighting a text position

### Recommended approach

Two stacked absolutely-positioned layers per page, which is exactly what Mozilla's own viewer does:

1. **Canvas layer** — `page.render({ canvasContext, viewport, canvas })`.
2. **Text layer** — transparent, selectable spans positioned over the canvas.

In a client component (`"use client"`), with the worker configured **once**:

```ts
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs", import.meta.url
).toString();
```

Use the **modern** build in the browser (legacy is only for old browsers / Node) and let the bundler
resolve the worker via `import.meta.url`. The worker version must match the API version exactly or
pdf.js throws — since one `pdfjs-dist` entry in `package.json` serves both halves, this is automatic.

### Text layer API (v6)

`renderTextLayer()` is gone. The current API, from the shipped
`types/src/display/text_layer.d.ts`:

```ts
new TextLayer({
  textContentSource: ReadableStream | TextContent,  // i.e. page.getTextContent()
  container: HTMLElement,
  viewport: PageViewport,
  images?: TextLayerImages,
}).render();
// then: .textDivs, .textContentItemsStr, .update({viewport}), .cancel()
```

`textDivs` is the payoff: **one DOM element per text item, index-aligned with the `items` array from
`getTextContent()`**. That is the bridge between ingest and viewer.

### Scrolling to / highlighting an extracted position — **yes, two independent ways**

**By item index (simplest).** If ingest stored the item index for a heading or citation, then at view
time `textLayer.textDivs[i]` is that exact element: `.scrollIntoView()` it, or set a background /
`::selection`-style highlight class on it. No coordinate math.

**By coordinates (robust to text-layer changes, and what I verified).** Map the stored `transform`
into device space:

```ts
const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
// m[4] = x_device, m[5] = baseline y_device (top-down);
// box = { left: m[4], top: m[5] - item.height * scale,
//         width: item.width * scale, height: item.height * scale }
```

**This is empirically verified, not inferred.** I rendered PDF page 101 server-side at scale 2
(1008×1323), computed that box for the `"B-Trees"` item, stroked it in red, and stroked every other
item in blue. The red box lands exactly on the `"B-Trees"` heading and the blue boxes track every
line of body text tightly. Screenshot artifact:
`/private/tmp/claude-501/-Users-kobil-ReadHelper/19f395d8-bbae-4d9f-a889-e7a5f0b37b82/scratchpad/pdfjstest/page101.png`
(scratchpad — regenerate with `t7.mjs` there if needed).

Because the box is derived from `viewport.transform`, it rescales correctly with zoom: recompute the
viewport, recompute the box. An absolutely-positioned overlay div at those coordinates gives you unit
range highlighting for free.

### Library or hand-rolled?

`react-pdf@10.4.1` wraps this in `<Document>`/`<Page>` with `renderTextLayer`, and is the low-effort
path. **But it depends on `pdfjs-dist@5.4.296`, one major behind.** Using it alongside a v6 ingest
pipeline means two copies of pdf.js at different majors in one project — divergent text-layer
behavior and two worker versions to keep straight, for a viewer that is roughly 80 lines of
`useEffect` to write by hand. Given that this app needs coordinate control anyway (highlighting unit
ranges from stored extraction output), hand-rolling on `pdfjs-dist` directly is the better trade here.

Sources: [pdf.js examples](https://github.com/mozilla/pdf.js/tree/master/examples),
[viewer `text_layer_builder`](https://github.com/mozilla/pdf.js/blob/master/web/text_layer_builder.js),
[`react-pdf`](https://www.npmjs.com/package/react-pdf), shipped v6 type definitions.

---

## 5. One library for both halves?

**Yes.** The concern behind the ticket — that ingest coordinates and viewer coordinates might not
agree — does not materialise, because both halves consume the *same* `getTextContent()` output and the
*same* `getViewport()` transform. There is no second coordinate system to reconcile.

Demonstrated in one process: same `pdfjs-dist@6.2.108`, extracted text with positions, rendered the
page to a canvas, and overlaid the extracted positions on the render with pixel accuracy (§4).
Server-side render of page 101 at scale 2 took 185 ms via `@napi-rs/canvas`, so the same code path
even works for pre-generating page thumbnails at ingest if that's ever wanted.

Performance is a non-issue: **1.94 s for all 613 pages** of text. The whole structural pass — labels,
outline, text, citation regex — completes in about two seconds, comfortably inside the map's
"roadmap visible in seconds" goal, with no need to parallelise or stream.

### If you ever need to replace the extraction half

Not recommended now, but for the record:

| Option | Tradeoff |
|---|---|
| **unpdf** 1.8.0 (`node>=22`) | Serverless-optimised pdf.js repack, zero deps, nicer ergonomics. But it wraps pdf.js — you inherit the same engine while *losing* direct access to `commonObjs`, `Util.transform` and the viewport, which are precisely what makes coordinate agreement work here. Wrong trade for this app. |
| **mupdf** 1.28.0 | Different, very solid engine (WASM). Genuinely better structured-text and layout analysis than pdf.js. But its coordinates are its own — pairing it with a pdf.js viewer reintroduces exactly the two-coordinate-system problem the ticket set out to avoid. Also AGPL: fine for a local single-user app, a licensing decision if that ever changes. |
| **poppler CLI** (`pdftotext -bbox-layout`) | Already installed and proven on this file. Best kept in the role the ticket assigned it: an **out-of-band ground-truth oracle** for testing ingest output. Shelling out to a binary is not a shipping dependency for a local TS app. |
| **pdf-parse / pdf2json** | Text-only, no rendering, no coordinate parity. Strictly worse for this use case. |

---

## Recommendation

**Ingest and rendering: `pdfjs-dist@^6.2.108`, one dependency, one version, both halves.**

```jsonc
// package.json
"dependencies": {
  "pdfjs-dist": "^6.2.108"       // @napi-rs/canvas arrives as an optional dep automatically
}
```

```ts
// next.config.ts
serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"]
```

- **Server / ingest:** `import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"` in the route
  handler. Set no `workerSrc`. Requires Node ≥22.13.
- **Client / viewer:** `import * as pdfjsLib from "pdfjs-dist"` in a `"use client"` component, set
  `GlobalWorkerOptions.workerSrc` via `new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url)`.
  Hand-roll canvas + `TextLayer` rather than adopting `react-pdf`, which would pin a second, older
  copy of pdf.js.
- **Keep poppler** as a dev-time oracle for ingest tests. Not a dependency.

**Do not add** unpdf, mupdf, pdf-parse, or react-pdf. Each either duplicates pdf.js or breaks the
single-coordinate-space property that makes this design work.

### Consequences for the map

1. **`getPageLabels()` replaces the printed→PDF offset inference entirely.** The map's "everything
   downstream depends on this offset" concern is resolved — the mapping is read from the file, exact,
   and covers the roman front matter. Store the 613-entry label array at ingest and index it.
2. **The map's "No PDF bookmark outline" fact is wrong and should be corrected.** A 210-node,
   4-level Part→Chapter→H2→H3 outline with page-resolved destinations exists. Re-scope the ToC work:
   outline as primary structure source, printed ToC text as cross-check.
3. **Citation counts are now exact, not extrapolated:** 238 `see "X" on page N` and 425 `Chapter N`
   across the full book (the map estimated ~250 and ~500 from a page-range sample).
4. **Add a de-hyphenation step** before matching citation targets to titles, or ~a handful of edges
   involving line-broken section names will silently fail to resolve.
5. **Never persist `fontName`.** Resolve it within the load session.

---

## Could not establish / open questions

- **`getPageLabels()` returning `null`** — confirmed from the worker source that missing/invalid
  `/PageLabels` yields `null`, but not exercised against a real label-less PDF, since the pilot book
  has one. Handle `null` defensively; the generic-engine goal means the second book may well lack it,
  and then footer scraping (§1a) becomes the fallback rather than a cross-check.
- **Whether outline coverage generalises.** DDIA's outline is excellent. Many technical PDFs have
  none, or a shallow chapter-only one. The generic engine still needs the printed-ToC parser as a
  fallback path — this research only removes it from the *critical* path for the pilot.
- **Reading-order guarantee.** Content-stream order matched visual order on every page I sampled, but
  I did not verify all 613, and it is a producer property rather than a spec guarantee. Multi-column
  or figure-heavy pages are the risk.
- **Next.js config not executed.** `serverExternalPackages` is reasoned from the package's runtime
  file loading plus the reported bundler failures, not tested — there is no Next.js app in the repo
  yet. Worth confirming on the first route handler, especially if `next build` standalone output is
  ever used.
- **`@napi-rs/canvas` on other platforms.** Verified on macOS (darwin arm64) only. It ships prebuilt
  per-platform binaries; irrelevant while this stays a local app.
- **pdf.js v6 changelog** — the breaking changes listed are from the shipped v6 sources, types and
  package metadata I inspected directly, plus community migration reports. I did not find a
  first-party v5→v6 migration document; if one exists it may list more.

---

## Reproducing

Scripts used are in the session scratchpad (not committed):
`/private/tmp/claude-501/-Users-kobil-ReadHelper/19f395d8-bbae-4d9f-a889-e7a5f0b37b82/scratchpad/pdfjstest/`
— `t1` labels+outline, `t2` text-item shape+footers, `t3` real font names, `t5` alias instability,
`t6` full-document timing + citation harvest, `t7` render + coordinate overlay, `t8` build/import
matrix, `t9` outline depth. Being a temp directory, these will not survive; the commands are simple
enough to rebuild from the snippets above.
