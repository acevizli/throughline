import { z } from "zod";
import { viaAgent } from "./agent";
import { viaApi } from "./api";

/**
 * The one place a model is asked anything.
 *
 * Two backends answer the same question — "fill in this shape, from these pages
 * only" — and nothing upstream learns which one did. `agent` drives the Claude
 * Code installed on this machine, so a course costs a subscription rather than a
 * token bill; `api` is the metered path, kept because it is the only way to hold
 * a briefing written by one against a briefing written by the other.
 */
export const MODEL = "claude-sonnet-4-6";

export type Backend = "agent" | "api";

/**
 * The shape is written once, in zod, and both backends are handed it: the API
 * gets it as a JSON Schema for constrained decoding, the agent as a tool's input
 * schema. Neither is a request — both are the decoding constraint itself, which
 * is what keeps `usable()` a check on meaning rather than on syntax.
 */
export interface Ask<Shape extends z.ZodRawShape> {
  /** Who the model is and what it may not do. Replaces the harness's own. */
  system: string;
  prompt: string;
  /** The tool the agent backend hands its answer to. Verb-first, snake case. */
  emit: string;
  emitDescription: string;
  shape: Shape;
}

export function backend(): Backend {
  return process.env.THROUGHLINE_BACKEND === "api" ? "api" : "agent";
}

/**
 * Why the current backend cannot be asked anything, or null if it can.
 *
 * Only the API path can be ruled out cheaply — a missing key is a fact on this
 * machine. Whether the local agent is logged in is not knowable without spawning
 * it, so it is left to fail loudly at the call and be reported as the error it
 * is, rather than guessed at behind a probe that would cost as much as the call.
 */
export function unready(): string | null {
  if (backend() === "api" && !process.env.ANTHROPIC_API_KEY) {
    return "THROUGHLINE_BACKEND is api but no ANTHROPIC_API_KEY is set.";
  }
  return null;
}

export async function ask<Shape extends z.ZodRawShape>(
  request: Ask<Shape>,
): Promise<z.infer<z.ZodObject<Shape>>> {
  const answer =
    backend() === "agent" ? await viaAgent(request) : await viaApi(request, schema(request.shape));

  // Parsed rather than cast, even though both backends already constrain the
  // shape — the agent through the tool's input schema, the API through
  // decoding. That is exactly why a violation here is worth failing on: it
  // means something broke upstream (a truncated response, a refusal, an SDK
  // change), and a zod error naming the field beats handing `undefined` to a
  // caller that will quietly treat it as an empty briefing.
  return z.object(request.shape).parse(answer);
}

/**
 * The zod shape as a JSON Schema the structured-output decoder will accept.
 *
 * Two things zod emits have to come off. `$schema` is a dialect declaration the
 * API reads as an unknown property; `minimum`/`maximum` are the ±2^53 bounds
 * `z.int()` adds, and numeric range constraints are not supported by constrained
 * decoding at all — left in, they get the whole schema rejected. Both are lost
 * without consequence: nothing here depends on a page number being under nine
 * quadrillion, and `usable()` re-checks integer-ness against the unit's own
 * range anyway.
 */
function schema(shape: z.ZodRawShape): Record<string, unknown> {
  return strip(z.toJSONSchema(z.strictObject(shape))) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "minimum" || key === "maximum") continue;
    out[key] = strip(value);
  }
  return out;
}
