import { Book } from "./pdf/book";
import { chapters, segment } from "./ingest/segments";
import { nameUnits } from "./ingest/name";
import { DEFAULTS, toUnits, type Unit } from "./ingest/units";
import { backend } from "./model/ask";

const args = process.argv.slice(2);
const shouldName = args.includes("--name");
const [path, minutes] = args.filter((a) => !a.startsWith("--"));
const targetMinutes = Number(minutes) || DEFAULTS.targetMinutes;

if (!path) {
  console.error("usage: tsx src/cli.ts <book.pdf> [targetMinutes] [--name]");
  process.exit(1);
}

const started = Date.now();
const book = await Book.open(path);
const segments = segment(book);
const grouped = chapters(segments);
let units = toUnits(grouped, { ...DEFAULTS, targetMinutes });
const structuralSeconds = ((Date.now() - started) / 1000).toFixed(1);

const name = path.split("/").pop()!;
if (shouldName) {
  // Only the metered path wants the key, and the agent path must not see one:
  // Claude Code resolves ANTHROPIC_API_KEY ahead of the login on this machine,
  // so loading it here would quietly put the naming pass back on the meter.
  if (backend() === "api") process.loadEnvFile(".env"); // never read here — only handed to the SDK
  units = await nameUnits(units, name.replace(/\.pdf$/i, ""));
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n${name}`);
console.log(
  `${book.pageCount} pages · ${book.outline.length} outline nodes · ` +
    `page labels ${book.pageLabels ? "yes" : "no"} · structural pass ${structuralSeconds}s` +
    `${shouldName ? ` · +naming, ${seconds}s total` : ""}\n`,
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
