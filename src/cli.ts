import { Book } from "./pdf/book.js";
import { chapters, segment } from "./ingest/segments.js";
import { DEFAULTS, toUnits, type Unit } from "./ingest/units.js";

const path = process.argv[2];
const targetMinutes = Number(process.argv[3]) || DEFAULTS.targetMinutes;

if (!path) {
  console.error("usage: tsx src/cli.ts <book.pdf> [targetMinutes]");
  process.exit(1);
}

const started = Date.now();
const book = await Book.open(path);
const segments = segment(book);
const grouped = chapters(segments);
const units = toUnits(grouped, { ...DEFAULTS, targetMinutes });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const name = path.split("/").pop();
console.log(`\n${name}`);
console.log(
  `${book.pageCount} pages · ${book.outline.length} outline nodes · ` +
    `page labels ${book.pageLabels ? "yes" : "no"} · structural pass ${seconds}s\n`,
);

let chapter = "";
for (const u of units) {
  if (u.chapter !== chapter) {
    chapter = u.chapter;
    console.log(`\n  ${chapter}`);
  }
  console.log(
    `    ${u.id}  ${u.title.slice(0, 44).padEnd(46)}` +
      `pp.${String(u.from).padStart(3)}–${String(u.to).padEnd(3)} ` +
      `${String(u.minutes).padStart(3)}min` +
      `${u.code > u.prose * 0.4 ? `  +${Math.round(u.code / 1000)}k code` : ""}`,
  );
  if (u.covers.length > 1) console.log(`          ${u.covers.slice(1).join(" · ").slice(0, 96)}`);
}

console.log(`\n${units.length} units · ${distribution(units)}`);
console.log(`total ${Math.round(units.reduce((n, u) => n + u.minutes, 0) / 60)}h of reading\n`);

function distribution(units: Unit[]): string {
  const mins = units.map((u) => u.minutes).sort((a, b) => a - b);
  const at = (q: number) => mins[Math.floor(mins.length * q)];
  return `min ${mins[0]} · p25 ${at(0.25)} · median ${at(0.5)} · p75 ${at(0.75)} · max ${mins.at(-1)}min`;
}
