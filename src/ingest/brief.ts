import Anthropic from "@anthropic-ai/sdk";

/**
 * What a unit adds to the page range you already have: a bridge into it, and
 * what you should be able to do once you're out.
 *
 * Deliberately small. There are no recall questions here (grading owns those),
 * no quotes, no per-objective page anchors and no prerequisites — every one of
 * those was considered and cut, because the unit's job is to point at the book,
 * not to stand in front of it.
 */
export interface Brief {
  /** At most 50 words. Empty when the unit assumes nothing new. */
  primer: string;
  objectives: string[];
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

export const MODEL = "claude-opus-5";

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
  const client = new Anthropic();

  const roadmap = preceding.length
    ? preceding.map((p) => `${p.id} ${p.title} (${p.chapter})`).join("\n")
    : "(nothing — this is the first unit of the book)";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          // No minItems/maxItems: constrained decoding rejects any minItems
          // above 1, so the count is asked for in the prompt and enforced below.
          properties: {
            primer: { type: "string" },
            objectives: { type: "array", items: { type: "string" } },
          },
          required: ["primer", "objectives"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You write the briefing that sits above a stretch of a technical book a reader is " +
      "about to read. The book is the source of knowledge and you are not: your job is to " +
      "aim the reader at the author's pages, never to save them the trouble of reading " +
      "them. Everything you write must come from the pages you are given — never from " +
      "your own knowledge of the subject, however sure you are of it.",
    messages: [
      {
        role: "user",
        content:
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
          "The pages follow.\n\n" +
          "-----\n" +
          text,
      },
    ],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block in briefing response");

  const parsed = JSON.parse(block.text) as Brief;
  return {
    primer: cap(parsed.primer ?? ""),
    // Sliced, not merely requested: the count is the ceiling on how much you
    // will be asked to recall, so it is not the model's to overrun.
    objectives: (parsed.objectives ?? [])
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, count),
  };
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
