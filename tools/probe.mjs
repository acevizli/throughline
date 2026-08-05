// Ingest-viability probe: can throughline build a course from this PDF?
// Reports the four things ingest depends on, per the map: page labels, outline,
// text layer quality, and self-citation density.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";

const path = process.argv[2];
const data = new Uint8Array(fs.readFileSync(path));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
const N = doc.numPages;

// --- 1. page labels ---
const labels = await doc.getPageLabels();

// --- 2. outline ---
const outline = await doc.getOutline();
let nodes = 0, byDepth = {};
const walk = (arr, d) => { byDepth[d] = (byDepth[d] || 0) + arr.length; for (const x of arr) { nodes++; if (x.items?.length) walk(x.items, d + 1); } };
if (outline) walk(outline, 1);

// --- 3. text layer: extract everything, measure quality ---
const t0 = Date.now();
let chars = 0, items = 0, emptyPages = 0, allText = [];
const sizes = new Map(); const fams = new Map();
const footers = [];
for (let p = 1; p <= N; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const real = tc.items.filter(i => i.str && i.str.trim());
  if (!real.length) { emptyPages++; allText.push(""); continue; }
  items += real.length;
  let pageStr = "";
  let bottom = null;
  for (const i of real) {
    chars += i.str.length;
    pageStr += i.str + (i.hasEOL ? "\n" : "");
    const h = Math.round(i.height * 100) / 100;
    if (h > 0) sizes.set(h, (sizes.get(h) || 0) + i.str.length);
    const fam = tc.styles?.[i.fontName]?.fontFamily;
    if (fam) fams.set(fam, (fams.get(fam) || 0) + i.str.length);
    if (bottom === null || i.transform[5] < bottom.transform[5]) bottom = i;
  }
  footers.push(bottom ? bottom.str.trim() : "");
  allText.push(pageStr);
  page.cleanup();
}
const ms = Date.now() - t0;
const text = allText.join("\n");

// --- 4. self-citation density ---
const precise = [...text.matchAll(/(?:see|See)\s+[“"][^”"]{3,60}[”"]\s+on\s+page\s+\d+/g)];
const chapterRefs = [...text.matchAll(/\bChapter\s+\d+\b/g)];
const pageRefs = [...text.matchAll(/\bon\s+page\s+\d+\b/g)];
const listingRefs = [...text.matchAll(/\bListing\s+\d+[-.]\d+/g)];
const figRefs = [...text.matchAll(/\bFigure\s+\d+[-.]\d+/g)];

// --- 5. link annotations (a different edge source than prose citations) ---
let internalLinks = 0;
for (const p of [1, Math.floor(N / 4), Math.floor(N / 2), Math.floor(3 * N / 4), N]) {
  const ann = await (await doc.getPage(p)).getAnnotations();
  internalLinks += ann.filter(a => a.subtype === "Link" && (a.dest || a.action)).length;
}

// --- footer numeric agreement (fallback tier for printed page numbers) ---
const numericFooters = footers.filter(f => /^\d+$/.test(f)).length;

const topSizes = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

console.log(JSON.stringify({
  file: path.split("/").pop(),
  pages: N,
  pageLabels: labels ? { present: true, sample: labels.slice(0, 6), hasRoman: labels.some(l => /^[ivxl]+$/.test(l)) } : { present: false },
  outline: outline ? { nodes, topLevel: outline.length, byDepth, firstFew: outline.slice(0, 5).map(o => o.title) } : { nodes: 0 },
  text: { chars, items, emptyPages, extractSeconds: +(ms / 1000).toFixed(2), charsPerPage: Math.round(chars / N) },
  fontFamilies: [...fams.entries()].sort((a, b) => b[1] - a[1]),
  sizeLadder: topSizes,
  footers: { numericOnly: numericFooters, pct: +(100 * numericFooters / N).toFixed(1), sample: footers.slice(30, 36) },
  citations: {
    precise_see_X_on_page_N: precise.length,
    chapter_refs: chapterRefs.length,
    on_page_N_total: pageRefs.length,
    listing_refs: listingRefs.length,
    figure_refs: figRefs.length,
  },
  internalLinksIn5Pages: internalLinks,
}, null, 2));
