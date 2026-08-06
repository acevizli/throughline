import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { MODEL, type Ask } from "./ask";

/**
 * Ask the metered API, with the shape as a constrained-decoding format.
 *
 * This is the path the project was built on and it is kept working, not kept
 * around: it is the only way to tell whether a briefing written by the local
 * agent is as good as one written here, and the only fallback if it isn't.
 */
export async function viaApi<Shape extends z.ZodRawShape>(
  request: Ask<Shape>,
  schema: Record<string, unknown>,
): Promise<unknown> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system: request.system,
    messages: [{ role: "user", content: request.prompt }],
  });

  // Both of these arrive as a successful response carrying unusable content, so
  // they have to be read off `stop_reason` rather than caught. `max_tokens` is
  // the one that actually bites: the JSON is cut mid-string, and without this
  // the failure surfaces as a parse error pointing at a column number.
  if (response.stop_reason === "refusal") {
    throw new Error(`the model declined: ${response.stop_details?.explanation ?? "no reason given"}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("the response hit max_tokens and is truncated");
  }

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block in the response");
  return JSON.parse(block.text);
}
