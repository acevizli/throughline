import Anthropic from "@anthropic-ai/sdk";
import type { Unit } from "./units.js";

/**
 * Give each unit a title that names the concept it covers.
 *
 * The structural pass titles a unit after whichever section opens it, which
 * produces units called "Summary" and units named after their least important
 * part. This is the one place a model is needed — and it is deliberately given
 * *only* the book's own headings, never the page text: a title assembled from
 * the author's section titles still says what the author said, which is what
 * the no-drift constraint requires. It also keeps the pass cheap enough to run
 * at ingest (~2k tokens for a 613-page book).
 */
export async function nameUnits(units: Unit[], bookTitle: string): Promise<Unit[]> {
  if (units.length === 0) return units;

  const client = new Anthropic();
  const outline = units
    .map((u) => `${u.id} [${u.chapter}] covers: ${u.covers.join(" | ")}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            units: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                },
                required: ["id", "title"],
                additionalProperties: false,
              },
            },
          },
          required: ["units"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You title study units for a reading guide. The book is the source of truth: a " +
      "title must be assembled from the section headings it covers, never invented from " +
      "your own knowledge of the subject. Reuse the author's wording wherever it fits.",
    messages: [
      {
        role: "user",
        content:
          `Book: ${bookTitle}\n\n` +
          "Each line below is one study unit: its id, its chapter, and the section " +
          "headings it covers in order. Give each unit a title naming the single idea " +
          "those sections share.\n\n" +
          "Rules:\n" +
          "- 2 to 6 words. No trailing punctuation.\n" +
          "- Name the concept, not the first section. A unit covering " +
          '"Writing to Column-Oriented Storage | Summary" is about column storage, not writing.\n' +
          '- Never title a unit "Summary", "Introduction", or the chapter\'s own name.\n' +
          "- Where one section clearly dominates, reuse its heading verbatim.\n" +
          "- Every id in the input must appear exactly once in the output.\n\n" +
          outline,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block in naming response");

  const named = new Map<string, string>(
    (JSON.parse(text.text).units as { id: string; title: string }[]).map((u) => [u.id, u.title]),
  );

  // A unit the model skipped keeps its structural title rather than losing one.
  return units.map((u) => ({ ...u, title: named.get(u.id) ?? u.title }));
}
