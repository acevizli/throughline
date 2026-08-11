// Retrieval probe: does semantic search over this book return the right passages?
//
// Chunks a page range with no layout analysis — a repaired text stream cut into
// overlapping sentence-snapped windows — embeds it, and ranks a query against it.
// This is the gate on #23: run it after the extractor lands and confirm the numbers
// recorded there still hold.
//
//   node tools/rag-probe.mjs "book.pdf" --from 69 --to 110 --query "…"
//
// Needs VOYAGE_API_KEY in .env.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
const QUERIES = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
  const name = argv[i].slice(2);
  const value = argv[++i];
  if (name === "query") QUERIES.push(value);
  else flags.set(name, value);
}
const PDF = positional[0];
const FROM_PRINTED = flags.get("from") ?? null;
const TO_PRINTED = flags.get("to") ?? null;
const TARGET = Number(flags.get("size") ?? 900);
const OVERLAP = Number(flags.get("overlap") ?? 0.25);

if (!PDF) {
  console.error('usage: node tools/rag-probe.mjs "book.pdf" --from 69 --to 110 --query "…"');
  process.exit(1);
}
const KEY = fs.readFileSync(".env", "utf8").match(/VOYAGE_API_KEY=(.+)/)?.[1]?.trim();
if (!KEY) { console.error("VOYAGE_API_KEY missing from .env"); process.exit(1); }

const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), verbosity: 0 }).promise;
const labels = await doc.getPageLabels();
const printedToIndex = (n) => (labels ? labels.indexOf(String(n)) + 1 : Number(n));
const printedOf = (p) => labels?.[p - 1] ?? String(p);

const FROM = FROM_PRINTED ? printedToIndex(FROM_PRINTED) : 1;
const TO = TO_PRINTED ? printedToIndex(TO_PRINTED) : doc.numPages;
console.log(`slice: printed ${FROM_PRINTED ?? "start"}-${TO_PRINTED ?? "end"} = pdf ${FROM}-${TO}`);

// ---------- the text stream, repaired ----------
// Three defects, all of them in the stream rather than in the chunk boundaries:
// a missing space where the font changes, a hyphen split across a line break, and
// the running head or foot repeating on every page. None needs layout analysis.
const OPENS = /[([{'"‘“¿¡]$/;
const CLOSES = /^[.,;:!?)\]}'"’”…%]/;

async function linesOf(p) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  const lines = [];
  let buf = "";
  let lastFont = null;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    // Code is out of the corpus — Kobil's call, recorded on #21.
    if (content.styles?.[item.fontName]?.fontFamily === "monospace") {
      if (item.hasEOL) { if (buf.trim()) lines.push(buf.trim()); buf = ""; lastFont = null; }
      continue;
    }
    if (item.str) {
      // pdf.js starts a new item when the font changes; joining blind welds words
      // into `asfractal` and `db_setfunction`.
      const weld = buf && lastFont && item.fontName !== lastFont &&
        !/\s$/.test(buf) && !/^\s/.test(item.str) && !OPENS.test(buf) && !CLOSES.test(item.str);
      buf += (weld ? " " : "") + item.str;
      lastFont = item.fontName;
    }
    if (item.hasEOL) { if (buf.trim()) lines.push(buf.trim()); buf = ""; lastFont = null; }
  }
  if (buf.trim()) lines.push(buf.trim());
  page.cleanup();
  return lines;
}

// A running head or foot is the page's first or last line, repeated across pages
// once its page number is blanked out. Nothing else about the page is needed.
const shape = (line) => line.replace(/\d+/g, "#");
const perPage = new Map();
const shapes = new Map();
for (let p = Math.max(1, FROM - 4); p <= Math.min(doc.numPages, TO + 4); p++) {
  const lines = await linesOf(p);
  perPage.set(p, lines);
  for (const l of [lines[0], lines[lines.length - 1]]) {
    if (l) shapes.set(shape(l), (shapes.get(shape(l)) || 0) + 1);
  }
}
const furniture = new Set([...shapes.entries()].filter(([, n]) => n >= 5).map(([s]) => s));
console.log(`page furniture dropped: ${[...furniture].map((f) => JSON.stringify(f.slice(0, 44))).join(", ") || "(none)"}`);

const stream = [];
for (let p = FROM; p <= TO; p++) {
  const lines = (perPage.get(p) ?? []).filter(
    (l, i, all) => !((i === 0 || i === all.length - 1) && furniture.has(shape(l))),
  );
  let text = "";
  for (const line of lines) {
    // A word split across a line break comes back as `imple‐` + `mentation`.
    if (/[-‐­]$/.test(text)) text = text.replace(/[-‐­]$/, "") + line;
    else text += (text ? " " : "") + line;
  }
  if (text.trim()) stream.push({ text: text.trim(), page: p });
}
const full = stream.map((s) => s.text).join(" ");
console.log(`stream: ${full.length} chars over ${stream.length} pages`);

const bounds = [];
{ let at = 0; for (const s of stream) { bounds.push({ at, page: s.page }); at += s.text.length + 1; } }
const pageAt = (offset) => { let page = bounds[0]?.page ?? FROM; for (const b of bounds) { if (b.at > offset) break; page = b.page; } return page; };

// ---------- windows ----------
// One size, never splitting a sentence, overlapping. The overlap is what
// small-to-big was for: a concept straddling a cut appears whole in its neighbour.
const sentences = [];
for (const m of full.matchAll(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)) {
  if (m[0].trim()) sentences.push({ text: m[0].trim(), at: m.index });
}
const chunks = [];
for (let i = 0; i < sentences.length; ) {
  let text = "";
  let j = i;
  while (j < sentences.length && text.length < TARGET) text += (text ? " " : "") + sentences[j++].text;
  if (text.length > 60) chunks.push({ text, page: pageAt(sentences[i].at) });
  if (j >= sentences.length) break;
  let back = j;
  let carried = 0;
  while (back > i + 1 && carried < text.length * OVERLAP) carried += sentences[--back].text.length;
  i = back;
}
const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
console.log(`chunks: ${chunks.length}, median ${lengths[lengths.length >> 1]} chars (target ${TARGET}, overlap ${OVERLAP * 100}%)\n`);
if (!QUERIES.length) { console.log("no --query given; stopping before the API call."); process.exit(0); }

// ---------- embed ----------
// The free tier's binding limit is 10K tokens/min, not the 3 requests/min and not
// the 1,000-texts-per-request cap: one batch of ~125 chunks returns 429.
const CHARS_PER_REQUEST = 28000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embed(input, inputType) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: "voyage-4", input_type: inputType }),
  });
  if (!response.ok) throw new Error(`voyage ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const batches = [];
for (let i = 0; i < chunks.length; ) {
  const batch = [];
  let size = 0;
  while (i < chunks.length && size + chunks[i].text.length < CHARS_PER_REQUEST) { size += chunks[i].text.length; batch.push(chunks[i++]); }
  batches.push(batch);
}
console.log(`embedding in ${batches.length} paced requests (~${batches.length} min)…`);
const vectors = [];
for (const [i, batch] of batches.entries()) {
  vectors.push(...(await embed(batch.map((c) => c.text), "document")));
  console.log(`  batch ${i + 1}/${batches.length}`);
  if (i < batches.length - 1) await sleep(62000);
}
await sleep(62000);
const queryVectors = await embed(QUERIES, "query");

const cosine = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
for (const [i, query] of QUERIES.entries()) {
  const ranked = chunks
    .map((c, k) => ({ ...c, score: cosine(queryVectors[i], vectors[k]) }))
    .sort((a, b) => b.score - a.score);
  console.log(`\n=== ${JSON.stringify(query)}`);
  for (const hit of ranked.slice(0, 4)) {
    console.log(`  ${hit.score.toFixed(3)}  p.${printedOf(hit.page)}  ${JSON.stringify(hit.text.slice(0, 140))}`);
  }
}
