import { setDone, setPlace } from "../../../lib/library";

/**
 * The only writes a reading session makes: a unit ticked off, or the place kept.
 *
 * Both are fire-and-forget from the reader's side — the UI has already moved,
 * and a lost tick costs one click rather than a re-ingest.
 */
export async function POST(request: Request) {
  const { book, unit, done, page } = (await request.json()) as {
    book?: string;
    unit?: string;
    done?: boolean;
    page?: number;
  };
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  if (typeof done === "boolean") setDone(book, unit, done);
  else if (Number.isInteger(page)) setPlace(book, unit, page!);
  else return new Response("done or page required", { status: 400 });

  return Response.json({ ok: true });
}
