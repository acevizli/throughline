import { brief, unbrief } from "../../../lib/library";

/**
 * A unit's briefing. Cached after the first call, so this is a database read
 * every time but once — the reader can ask for it on every open without
 * thinking about cost.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const book = params.get("book");
  const unit = params.get("unit");
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  if (params.get("fresh") === "1") unbrief(book, unit);

  const written = await brief(book, unit);
  if ("error" in written) return Response.json(written);

  // The same call writes the questions, and they carry their correct keys. They
  // do not go out with the briefing: the sidebar payload is readable in
  // devtools, and a quiz whose answers ship with the primer is not a quiz.
  return Response.json({ primer: written.primer, objectives: written.objectives });
}
