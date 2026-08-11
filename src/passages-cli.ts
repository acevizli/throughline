import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Book } from "./pdf/book";
import { passages, PASSAGE_DEFAULTS } from "./ingest/passages";

/**
 * What the passage extractor gets out of a book, printed for a human to read.
 *
 * The gate on #22 is not a number — it is whether a sample of these reads as
 * clean prose, with no welded words, no words broken across a line, and no
 * running head sitting in the middle of a sentence. So the report ends with
 * passages printed in full rather than counted.
 */
const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) flags.set(args[i].slice(2), args[i + 1] ?? "");
  else if (!args[i - 1]?.startsWith("--")) positional.push(args[i]);
}
const flag = (name: string, fallback: number) => Number(flags.get(name) ?? fallback);

const path = positional.find((a) => !isNumeric(a));
// `npm run passages book.pdf --sample 10` silently eats the flag — npm claims
// it as its own config and passes only the 10 along. Rather than depend on
// everyone remembering the `--`, a bare number is the sample count, which is
// how `npm run ingest` already takes its target minutes.
const positionalSample = positional.find(isNumeric);

if (!path) {
  console.error(
    "usage: npm run passages -- <book.pdf> [--sample 4] [--size 900] [--overlap 0.25] [--shelve]",
  );
  process.exit(1);
}

const started = Date.now();
const book = await Book.open(path);
const report = passages(book, {
  size: flag("size", PASSAGE_DEFAULTS.size),
  overlap: flag("overlap", PASSAGE_DEFAULTS.overlap),
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const name = path.split("/").pop()!;
const printed = (page: number) => book.printedOf(page) ?? `pdf ${page}`;
const bodyPages = report.to - report.from + 1;

console.log(`\n${name} — ${book.pageCount} pages, extracted in ${seconds}s\n`);
console.log(
  `  body      pdf ${report.from}–${report.to} (printed ${printed(report.from)}–${printed(report.to)}), ` +
    `${bodyPages} pages · ${book.pageCount - bodyPages} cut as apparatus`,
);
console.log(`  furniture ${report.furniture.length} running heads and feet dropped`);
console.log(
  `  hyphens   ${
    report.breaks.map((c) => `U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join(", ") ||
    "(none the typesetter's — every hyphen at a break is kept)"
  }`,
);
console.log(
  `  prose     ${report.chars.toLocaleString()} chars · ${Math.round(report.chars / bodyPages)} per body page · ` +
    `${report.lost === 0 ? "none lost" : `${report.lost} LOST`}`,
);

const lengths = report.passages.map((p) => p.text.length).sort((a, b) => a - b);
const at = (q: number) => lengths[Math.floor(lengths.length * q)];
console.log(
  `  passages  ${report.passages.length}` +
    `${report.duplicates ? ` · ${report.duplicates} duplicates dropped` : ""}` +
    ` · ${(report.passages.length / bodyPages).toFixed(1)} per page`,
);
console.log(
  `            min ${lengths[0]} · p25 ${at(0.25)} · median ${at(0.5)} · p75 ${at(0.75)} · max ${lengths.at(-1)} chars`,
);

const spanning = report.passages.filter((p) => p.to > p.from).length;
const unnamed = report.passages.filter((p) => !p.section).length;
console.log(
  `            ${spanning} cross a page break · ` +
    `${unnamed === 0 ? "every one" : `${report.passages.length - unnamed}`} carries a section`,
);

// Spread the sample across the book rather than taking the first few: the
// opening pages of a chapter are the easiest text in it.
const sample = flag("sample", Number(positionalSample ?? 4));
console.log(`\n  ── ${sample} passages, spread across the body ──`);
for (let i = 0; i < sample; i++) {
  const p = report.passages[Math.floor(((i + 0.5) / sample) * report.passages.length)];
  if (!p) break;
  const range = p.from === p.to ? `p.${printed(p.from)}` : `pp.${printed(p.from)}–${printed(p.to)}`;
  // A chapter's opening pages sit in a segment named after the chapter, so the
  // breadcrumb would otherwise read "Chapter 25 › Chapter 25".
  const where = [p.chapter, p.section].filter((s, i, all) => s && all.indexOf(s) === i).join(" › ");
  console.log(`\n  [${p.ord}] ${p.id.slice(0, 12)}…  ${range}  ${where}`);
  console.log(wrap(p.text, 92, "      "));
}
// Books shelved before passages existed have none, and re-adding the PDF would
// only find the same sha256 and hand back the course it already has.
if (args.includes("--shelve")) {
  const { shelved, storePassages } = await import("../lib/library");
  const id = createHash("sha256").update(await readFile(path)).digest("hex");
  if (!shelved(id)) {
    console.error(`\n  not on the shelf: ${id.slice(0, 12)}… — add it through the app first\n`);
    process.exit(1);
  }
  console.log(`\n  shelved ${storePassages(id, book)} passages under ${id.slice(0, 12)}…`);
}
console.log("");

function isNumeric(a: string): boolean {
  return a !== "" && !Number.isNaN(Number(a));
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > width) {
      lines.push(indent + line);
      line = "";
    }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}
