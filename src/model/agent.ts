import { tmpdir } from "node:os";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { MODEL, type Ask } from "./ask";

/** Namespaces the emit tool. The model sees it as `mcp__throughline__<emit>`. */
const SERVER = "throughline";

/**
 * Ask the Claude Code installed on this machine, and take its answer as a tool
 * call rather than as prose.
 *
 * The agent loop has no `output_config.format`, so the shape is carried by the
 * input schema of a tool that does nothing but record what it was given. That is
 * the same mechanism constrained decoding uses, reached from the other side: the
 * model is not asked to emit well-formed JSON, it is asked to make a call whose
 * arguments cannot be malformed.
 */
export async function viaAgent<Shape extends z.ZodRawShape>(request: Ask<Shape>): Promise<unknown> {
  // One retry, because the failure this backend actually has is a turn that ends
  // with a sentence instead of a call. That is worth asking again for; anything
  // thrown from inside the run — not logged in, no such model — is not, and is
  // let through on the first attempt.
  const first = await run(request);
  return first !== undefined ? first : ((await run(request)) ?? missing(request.emit));
}

async function run<Shape extends z.ZodRawShape>(request: Ask<Shape>): Promise<unknown> {
  let captured: unknown;

  const emit = tool(request.emit, request.emitDescription, request.shape, async (args) => {
    captured = args;
    return { content: [{ type: "text" as const, text: "Recorded." }] };
  });

  const stream = query({
    prompt: request.prompt,
    options: {
      model: MODEL,
      // A plain string replaces Claude Code's own preset. The preset is a
      // software-engineering harness, and this project's one rule is that
      // nothing is asserted that isn't on the author's pages — the two do not
      // belong in the same context.
      systemPrompt:
        `${request.system}\n\n` +
        // Named as the model sees it. It resolves the bare name in practice,
        // but the namespaced one is what `allowedTools` approves and what
        // appears in its tool list, so there is nothing to resolve.
        `Return your answer by calling the mcp__${SERVER}__${request.emit} tool exactly once. ` +
        "Everything it asks for, you have been given: do not go looking for more, " +
        "and do not write a reply alongside the call.",
      mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, tools: [emit] }) },
      // No built-in tools at all, which is the no-drift rule enforced rather
      // than asked for: a briefing that quietly consulted the web instead of
      // the pages in front of it is the exact failure this project exists to
      // prevent, and WebSearch is one turn away by default.
      tools: [],
      // `tools: []` only empties the *built-in* set. Whatever this machine's
      // Claude Code is connected to — Drive, Gmail, anything account-level —
      // arrives through a separate door, and did: the first run of this came
      // back holding eight Google Drive tools. This shuts that door.
      strictMcpConfig: true,
      // Nothing from ~/.claude or from this repo — including its own CLAUDE.md,
      // which is instructions about building throughline, not about the book.
      settingSources: [],
      // `allowedTools` is an approval list, not an availability one — the two
      // options above are what make the surface a single tool, and this is what
      // lets that tool run unattended. Not `bypassPermissions`, which would
      // auto-approve whatever else ever gets through, and not `dontAsk`, which
      // ends the session before the model is even called.
      allowedTools: [`mcp__${SERVER}__${request.emit}`],
      permissionMode: "default",
      thinking: { type: "adaptive" },
      effort: "medium",
      // Naming the session outright, because otherwise Claude Code spends a
      // second model call summarising the first user message into a title — and
      // the first user message here is eight thousand tokens of someone's book.
      title: `throughline ${request.emit}`,
      // The call itself takes three; the slack is for a turn spent thinking out
      // loud before it, which costs nothing to allow when there are no tools to
      // wander into.
      maxTurns: 5,
      // Nowhere near the repo, so a tool that somehow got through has nothing
      // of ours in reach.
      cwd: tmpdir(),
      env: sealed(),
    },
  });

  for await (const message of stream) {
    // Where the credentials came from and what the model can actually reach.
    // `auth=none` is what success looks like: no API key source was found, so
    // the session fell through to the login on this machine. Any other value
    // means a key survived `sealed()` and the work is being billed after all.
    // `tools` should hold nothing but the one that records the answer.
    if (message.type === "system" && message.subtype === "init" && process.env.THROUGHLINE_TRACE) {
      console.error(
        `[agent] auth=${message.apiKeySource} model=${message.model} ` +
          `tools=[${message.tools.join(", ")}]`,
      );
    }

    // What it cost and which models actually ran, for holding this backend
    // against the metered one. The estimate is what the same work would have
    // been billed at, not what a subscription is charged.
    if (message.type === "result") {
      if (process.env.THROUGHLINE_TRACE) {
        const models = message.subtype === "success" ? Object.keys(message.modelUsage ?? {}) : [];
        console.error(
          `[agent] ${request.emit} ${message.subtype} · ${message.num_turns} turns · ` +
            `${(message.duration_ms / 1000).toFixed(1)}s · ~$${message.total_cost_usd.toFixed(4)} · ` +
            models.join(", "),
        );
      }
      break;
    }
  }

  return captured;
}

/**
 * The environment the spawned Claude Code gets.
 *
 * The key has to come out. A child process inherits `process.env`, and Claude
 * Code resolves `ANTHROPIC_API_KEY` ahead of the login on this machine — so with
 * the key still set this backend would quietly bill the API at full rate while
 * looking exactly like it was using the subscription. `.env` holds one, and
 * `src/cli.ts` loads it, so this is the default outcome and not an edge case.
 */
function sealed(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function missing(emit: string): never {
  throw new Error(`the agent finished twice without calling ${emit}`);
}
