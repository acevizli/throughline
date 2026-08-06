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

  return Response.json(await brief(book, unit));
}
