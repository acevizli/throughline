import type { Key } from "../../../src/ingest/brief";
import { mark, quiz, retake } from "../../../lib/library";

/** A unit's questions, or the marked result if they've already been taken. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const book = params.get("book");
  const unit = params.get("unit");
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  return Response.json(await quiz(book, unit));
}

/** Submit an attempt. Marking is a set comparison — no model is involved. */
export async function POST(request: Request) {
  const { book, unit, picks } = (await request.json()) as {
    book?: string;
    unit?: string;
    picks?: Key[][];
  };
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  return Response.json(mark(book, unit, picks ?? []));
}

/** Drop the stored attempt, so the same questions can be taken again. */
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const book = params.get("book");
  const unit = params.get("unit");
  if (!book || !unit) return new Response("book and unit required", { status: 400 });

  retake(book, unit);
  return Response.json({ ok: true });
}
