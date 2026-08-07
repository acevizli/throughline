import { pages } from "../../../lib/library";

/**
 * The text and links of one page, for the layer laid over its PNG.
 *
 * Deliberately the same shape of route as `/api/page` and cached on the same
 * terms — but with no `scale` parameter, because the geometry is in PDF units
 * and one response serves every zoom level.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const book = params.get("book");
  // Whole numbers only: pdf.js indexes pages by integer, and `page=1.5` gets
  // all the way to getPage() before failing as a 500.
  const page = Number(params.get("page"));
  if (!book || !Number.isInteger(page) || page < 1) {
    return new Response("book and a whole page number required", { status: 400 });
  }

  const opening = pages(book);
  if (!opening) return new Response("no such book", { status: 404 });

  const pdf = await opening;
  if (page > pdf.pageCount) return new Response("out of range", { status: 404 });

  return Response.json(await pdf.geometry(page), {
    headers: { "cache-control": "public, max-age=31536000, immutable" },
  });
}
