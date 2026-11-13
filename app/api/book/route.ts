import { backfillLabels, course, forget, touch } from "../../../lib/library";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });

  // Every page number in the reader is one of these, so they have to be here
  // before the units are. Costs one PDF open, once per book ever shelved
  // before the column existed; a row read afterwards.
  await backfillLabels(id);

  const found = course(id);
  if (!found) return new Response("no such book", { status: 404 });

  // Opening counts as reading: the shelf orders by it.
  touch(id);
  return Response.json(found);
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });
  await forget(id);
  return Response.json({ ok: true });
}
