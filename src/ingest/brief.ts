import { z } from "zod";
import { ask } from "../model/ask";

/** The four option slots. Fixed, because arrays take no length constraint. */
export const KEYS = ["a", "b", "c", "d"] as const;
export type Key = (typeof KEYS)[number];

/**
 * One option, and the page that settles it.
 *
 * The page is the whole point. Marking an option wrong is the system asserting
 * the book says otherwise, and an assertion with no page behind it is exactly
 * the drift this project exists not to do. Right options cite where the book
 * says so; wrong ones cite where it says otherwise.
 */
export interface Option {
  text: string;
  /** 1-based PDF page index, always inside the unit's own range. */
  page: number;
}

/** One question, checking exactly one objective. */
export interface Question {
  stem: string;
  options: Record<Key, Option>;
  /** One or two keys. Never revealed to the reader before they answer. */
  correct: Key[];
}

/**
 * What a unit adds to the page range you already have: a bridge into it, what
 * you should be able to do once you're out, and the questions that check it.
 *
 * All three come from one call. Splitting question generation into its own pass
 * would have meant reading the same ~8k tokens of pages a second time to write
 * about objectives that call already had in hand.
 */
export interface Brief {
  /** At most 50 words. Empty when the unit assumes nothing new. */
  primer: string;
  objectives: string[];
  /** One per objective, in the same order. Shorter when validation drops one. */
  questions: Question[];
}

/** One entry of the roadmap above this unit — what the reader has already met. */
export interface Prior {
  id: string;
  title: string;
  chapter: string;
}

export interface BriefRequest {
  bookTitle: string;
  unit: {
    id: string;
    title: string;
    chapter: string;
    from: number;
    to: number;
    minutes: number;
    covers: string[];
  };
  /** The author's own text for the unit's page range. */
  text: string;
  /** Units before this one, in order. Only these may be referred to. */
  preceding: Prior[];
}

const PRIMER_WORDS = 50;

/**
 * How many objectives a unit gets: roughly one per 12 minutes of prose, floored
 * at 2 and capped at 5.
 *
 * Derived from the unit's measured size rather than fixed, because units
 * genuinely span 15–90 minutes — a fixed count pads the short ones and truncates
 * the long ones. Capped because every objective is also something you will be
 * asked to recall, and a 39-unit book at six apiece is a slog.
 */
export function objectiveCount(minutes: number): number {
  return Math.min(5, Math.max(2, Math.round(minutes / 12)));
}

export async function writeBrief(request: BriefRequest): Promise<Brief> {
  const { bookTitle, unit, text, preceding } = request;
  const count = objectiveCount(unit.minutes);

  const roadmap = preceding.length
    ? preceding.map((p) => `${p.id} ${p.title} (${p.chapter})`).join("\n")
    : "(nothing — this is the first unit of the book)";

  // Four named slots rather than an array of four: constrained decoding rejects
  // every array length constraint there is (minItems above 1, maxItems,
  // prefixItems), but it does enforce required object keys. So the option set is
  // structurally guaranteed to be exactly four, and only "one or two correct"
  // is left to enforce in code.
  const option = z.strictObject({ text: z.string(), page: z.int() });

  const parsed = await ask({
    emit: "emit_briefing",
    emitDescription: "Record the briefing for this unit. Call this exactly once.",
    shape: {
      primer: z.string(),
      objectives: z.array(z.string()),
      questions: z.array(
        z.strictObject({
          stem: z.string(),
          a: option,
          b: option,
          c: option,
          d: option,
          // enum *is* enforced, so a key outside a–d cannot come back.
          correct: z.array(z.enum(KEYS)),
        }),
      ),
    },
    system:
      "You write the briefing that sits above a stretch of a technical book a reader is " +
      "about to read. The book is the source of knowledge and you are not: your job is to " +
      "aim the reader at the author's pages, never to save them the trouble of reading " +
      "them. Everything you write must come from the pages you are given — never from " +
      "your own knowledge of the subject, however sure you are of it.",
    prompt:
      `Book: ${bookTitle}\n` +
      `Chapter: ${unit.chapter}\n` +
      `Unit ${unit.id}: ${unit.title} — pages ${unit.from}–${unit.to}, about ${unit.minutes} minutes of reading\n` +
      `Sections it covers: ${unit.covers.join(" | ")}\n\n` +
      "The reader has already worked through these units, in this order:\n" +
      `${roadmap}\n\n` +
      "Write two things.\n\n" +
      `**primer** — at most ${PRIMER_WORDS} words, and usually fewer. It has exactly one ` +
      "job: name what the author takes as already known at the start of these pages, and " +
      "where the reader met it. Refer to earlier units by id and title when the ground was " +
      "covered above; say plainly that it is assumed but was never covered when it wasn't. " +
      "Nothing else belongs here. Do not say what these pages are about, do not frame why " +
      "the chapter exists, do not pose the question they answer, and do not state any " +
      "definition, distinction or conclusion that appears in them. Return an empty string " +
      "if the unit assumes nothing the reader has not already met.\n\n" +
      `**objectives** — exactly ${count}. Each is one thing the reader should be able to do ` +
      "after these pages, phrased as a capability: start with a verb (Explain, Compare, " +
      "Trace, Derive, Predict). Use the author's own terms for the things involved. One " +
      "capability per objective — do not bundle two into one with \"and\". If the pages " +
      `teach more than ${count} load-bearing ideas, pick the ${count} that carry the most ` +
      "weight and leave the rest to the pages; never mention anything the pages do not " +
      "teach. No trailing punctuation.\n\n" +
      `**questions** — exactly ${count}, one per objective, in the same order as the ` +
      "objectives. Each checks whether the reader can actually do the thing that " +
      "objective names, from memory, with the book closed.\n\n" +
      "Each question has a stem and four options `a`–`d`. **One or two of them are " +
      "correct — never zero, never three, and vary which.** The reader is not told how " +
      "many, so a second correct option must be genuinely correct and a wrong one " +
      "genuinely wrong; do not include a near-miss you would argue about.\n\n" +
      "Wrong options are the misreadings these pages exist to prevent — a plausible " +
      "confusion the author explicitly settles, the right answer to a neighbouring " +
      "question, a true statement that does not answer this stem. Never obviously " +
      "absurd filler.\n\n" +
      "**Every option carries the page that settles it.** The pages below are marked " +
      "`[[page N]]` before each page's text. For a correct option, cite the page where " +
      "the author says so. For a wrong option, cite the page where the author says " +
      "otherwise — the passage a reader would go to to see why it is wrong. Use only " +
      `page numbers that appear as markers below (${unit.from}–${unit.to}); if you cannot ` +
      "point at a page for an option, rewrite the option until you can.\n\n" +
      "Ask about what the pages argue, not what they mention: nothing about which figure " +
      "shows what, what a section is called, or which company an example came from. Never " +
      "write an option that only makes sense to someone with the book open.\n\n" +
      "The pages follow, each marked with its page number.\n\n" +
      "-----\n" +
      text,
  });

  const objectives = (parsed.objectives ?? [])
    .map((o) => o.trim())
    .filter(Boolean)
    // Sliced, not merely requested: the count is the ceiling on how much you
    // will be asked to recall, so it is not the model's to overrun.
    .slice(0, count);

  return {
    primer: cap(parsed.primer ?? ""),
    objectives,
    questions: (parsed.questions ?? [])
      .slice(0, objectives.length)
      .map((q) => usable(q, unit.from, unit.to))
      .filter((q): q is Question => q !== null),
  };
}

/**
 * A question, or null if it failed validation.
 *
 * This is the mechanical drift check the briefing itself never got. A page
 * outside the unit's own range is a page the model did not read — it invented
 * it — and an option whose anchor is invented is precisely the assertion this
 * project is not allowed to make. So the question is dropped rather than shown
 * with a citation that doesn't hold. Losing a question costs one line of a
 * results panel; showing a fabricated page costs the only rule that matters.
 */
function usable(
  q: Record<Key, Option> & { stem?: string; correct?: Key[] },
  from: number,
  to: number,
): Question | null {
  const stem = q.stem?.trim();
  if (!stem) return null;

  const options = {} as Record<Key, Option>;
  for (const key of KEYS) {
    const text = q[key]?.text?.trim();
    const page = q[key]?.page;
    if (!text || !Number.isInteger(page) || page < from || page > to) return null;
    options[key] = { text, page };
  }

  // The enum guarantees the keys are a–d; it cannot guarantee how many, and
  // "at most two" is the difference between a question and a giveaway.
  const correct = [...new Set(q.correct ?? [])].filter((k) => KEYS.includes(k));
  if (correct.length < 1 || correct.length > 2) return null;

  return { stem, options, correct };
}

/**
 * The word cap is what stops a primer becoming a summary, so it is enforced
 * here rather than only asked for: a field that cannot exceed fifty words
 * cannot quietly turn into the chapter the reader was supposed to read.
 */
function cap(primer: string, words = PRIMER_WORDS): string {
  const parts = primer.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= words) return parts.join(" ");
  return parts.slice(0, words).join(" ").replace(/[,;:]$/, "") + "…";
}
