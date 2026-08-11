import { NON_TEACHING, type Chapter, type Segment } from "./segments";

/** A unit of study: one sitting, one coherent stretch of the book. */
export interface Unit {
  id: string;
  title: string;
  chapter: string;
  /** 1-based PDF pages, inclusive. */
  from: number;
  to: number;
  prose: number;
  code: number;
  /** Estimated reading minutes — prose only; code is counted separately. */
  minutes: number;
  /** The outline nodes this unit covers, in order. */
  covers: string[];
}

export interface UnitOptions {
  /** Target minutes of prose per unit. */
  targetMinutes: number;
  /** Characters of technical prose read per minute. */
  charsPerMinute: number;
  /** A trailing group below this share of the target is folded back, not shipped. */
  minShare: number;
}

export const DEFAULTS: UnitOptions = {
  targetMinutes: 35,
  // ~150 wpm for dense technical prose at ~5.5 chars/word. Deliberately slower
  // than general reading: this is material you stop and think about.
  charsPerMinute: 825,
  minShare: 0.4,
};

/**
 * Merge segments into units, never splitting one and never crossing a chapter.
 *
 * Merge-only is what keeps page ranges exact: every unit's range is the union of
 * outline extents, so it is derived rather than guessed. The cost is that a
 * single oversized segment stays oversized — surfaced rather than hidden.
 */
export function toUnits(chapters: Chapter[], options: UnitOptions = DEFAULTS): Unit[] {
  const budget = options.targetMinutes * options.charsPerMinute;
  const units: Unit[] = [];

  for (const chapter of chapters) {
    const teaching = chapter.segments.filter(isTeachingMatter);
    if (teaching.length === 0) continue;

    for (const group of groupByBudget(teaching, budget, options.minShare)) {
      units.push(build(group, chapter.title, units.length + 1, options));
    }
  }

  // Part dividers open a "chapter" of their own and contribute a page or two of
  // framing before the first real chapter starts. Drop them — but only them: a
  // genuinely short chapter (Clean Code's 10-minute "JUnit Internals") is still
  // a unit, so the test is what the heading *is*, not merely that it's small.
  const kept = units.filter((u) => {
    const alone = units.filter((v) => v.chapter === u.chapter).length === 1;
    return !(alone && (PART_DIVIDER.test(u.chapter) || u.prose < budget * 0.15));
  });

  return kept.map((u, i) => ({ ...u, id: `U${String(i + 1).padStart(2, "0")}` }));
}

/** Accumulate segments until the budget is met; fold a runt tail into the previous group. */
function groupByBudget(segments: Segment[], budget: number, minShare: number): Segment[][] {
  const groups: Segment[][] = [];
  let current: Segment[] = [];
  let prose = 0;

  for (const s of segments) {
    current.push(s);
    prose += s.prose;
    if (prose >= budget) {
      groups.push(current);
      current = [];
      prose = 0;
    }
  }

  if (current.length > 0) {
    if (prose < budget * minShare && groups.length > 0) groups[groups.length - 1].push(...current);
    else groups.push(current);
  }
  return groups;
}

function build(group: Segment[], chapter: string, index: number, options: UnitOptions): Unit {
  const prose = group.reduce((n, s) => n + s.prose, 0);
  const code = group.reduce((n, s) => n + s.code, 0);

  return {
    id: `U${String(index).padStart(2, "0")}`,
    // The first segment names the unit; the rest are listed in `covers`.
    // Naming a merged unit by its *concept* is #4's open question — inventing a
    // title here would be the system asserting something the book didn't say.
    title: group[0].title,
    chapter,
    from: group[0].from,
    to: Math.max(...group.map((s) => s.to)),
    prose,
    code,
    minutes: Math.round(prose / options.charsPerMinute),
    covers: group.map((s) => s.title),
  };
}

const PART_DIVIDER = /^part\b/i;

function isTeachingMatter(s: Segment): boolean {
  if (NON_TEACHING.test(s.title)) return false;
  // A heading with almost nothing under it is a divider, not a section.
  return s.prose + s.code > 200;
}
