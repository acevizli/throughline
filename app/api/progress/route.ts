import { setDone, setPlace } from "../../../lib/library";

/**
 * The only writes a reading session makes: a unit ticked off, or the place kept.
 *
 * Both are fire-and-forget from the reader's side — the UI has already moved,
 * and a lost tick costs one click rather than a re-ingest.
 */
export async function POST(request: Request) {
  const { book, unit, done } = (await request.json()) as {
    book?: string;
    unit?: string;
    done?: boolean;
  };
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  if (typeof done === "boolean") setDone(book, unit, done);
  else setPlace(book, unit);

  return Response.json({ ok: true });
}
