// Retrieval probe: does semantic search over this book return the right passages?
//
// Embeds a slice of a book and ranks queries against it. The chunking is not in
// here — it is `src/ingest/passages.ts`, the same extractor that fills the
// shelf, because a probe measuring something other than what ships measures
// nothing. This is the gate on #23: run it after changing the extractor and
// confirm the numbers in tools/README.md still hold.
//
//   npm run rag-probe -- "book.pdf" --from 69 --to 110 --query "…"
//
// Needs VOYAGE_API_KEY in .env.
import { readFileSync } from "node:fs";
import { Book } from "../src/pdf/book";
import { passages, PASSAGE_DEFAULTS } from "../src/ingest/passages";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
const QUERIES: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) {
    positional.push(argv[i]);
    continue;
  }
  const name = argv[i].slice(2);
  const value = argv[++i];
  // Every flag here takes a value. Left off, `--query` would embed an
  // undefined and `--size` would become NaN, both of which fail much later
  // and somewhere else.
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  if (name === "query") QUERIES.push(value);
  else flags.set(name, value);
}

const PDF = positional[0];
if (!PDF) {
  console.error('usage: npm run rag-probe -- "book.pdf" --from 69 --to 110 --query "…"');
  process.exit(1);
}
const KEY = readFileSync(".env", "utf8").match(/VOYAGE_API_KEY=(.+)/)?.[1]?.trim();
if (!KEY) {
  console.error("VOYAGE_API_KEY missing from .env");
  process.exit(1);
}

const book = await Book.open(PDF);
const fromPrinted = flags.get("from");
const toPrinted = flags.get("to");
// Printed page numbers in, PDF indices out — the slice is quoted from the book,
// so it is named the way the book names it.
const range =
  fromPrinted || toPrinted
    ? {
        from: (fromPrinted && book.printedToIndex(fromPrinted)) || 1,
        to: (toPrinted && book.printedToIndex(toPrinted)) || book.pageCount,
      }
    : undefined;

const report = passages(
  book,
  {
    size: Number(flags.get("size") ?? PASSAGE_DEFAULTS.size),
    overlap: Number(flags.get("overlap") ?? PASSAGE_DEFAULTS.overlap),
  },
  range,
);
const chunks = report.passages;

const printed = (page: number) => book.printedOf(page) ?? `pdf ${page}`;
console.log(
  `slice: printed ${printed(report.from)}–${printed(report.to)} = pdf ${report.from}–${report.to}`,
);
console.log(`furniture dropped: ${report.furniture.length} shapes · break hyphens: [${report.breaks}]`);
console.log(`stream: ${report.chars} chars · ${report.lost} lost`);
const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
console.log(`passages: ${chunks.length}, median ${lengths[lengths.length >> 1]} chars\n`);
if (!QUERIES.length) {
  console.log("no --query given; stopping before the API call.");
  process.exit(0);
}

// The free tier's binding limit is 10K tokens/min, not the 3 requests/min and
// not the 1,000-texts-per-request cap: one batch of ~125 passages returns 429.
const CHARS_PER_REQUEST = 28000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embed(input: string[], inputType: "document" | "query"): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: "voyage-4", input_type: inputType }),
  });
  if (!response.ok) throw new Error(`voyage ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const batches: (typeof chunks)[] = [];
for (let i = 0; i < chunks.length; ) {
  const batch: typeof chunks = [];
  let size = 0;
  while (i < chunks.length && size + chunks[i].text.length < CHARS_PER_REQUEST) {
    size += chunks[i].text.length;
    batch.push(chunks[i++]);
  }
  batches.push(batch);
}
console.log(`embedding in ${batches.length} paced requests (~${batches.length} min)…`);

const vectors: number[][] = [];
for (const [i, batch] of batches.entries()) {
  vectors.push(...(await embed(batch.map((c) => c.text), "document")));
  console.log(`  batch ${i + 1}/${batches.length}`);
  if (i < batches.length - 1) await sleep(62000);
}
await sleep(62000);
const queryVectors = await embed(QUERIES, "query");

const cosine = (a: number[], b: number[]) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

for (const [i, query] of QUERIES.entries()) {
  const ranked = chunks
    .map((c, k) => ({ ...c, score: cosine(queryVectors[i], vectors[k]) }))
    .sort((a, b) => b.score - a.score);
  console.log(`\n=== ${JSON.stringify(query)}`);
  for (const hit of ranked.slice(0, 4)) {
    console.log(
      `  ${hit.score.toFixed(3)}  p.${printed(hit.from)}  ${JSON.stringify(hit.text.slice(0, 140))}`,
    );
  }
}
