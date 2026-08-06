import { course, forget, setPlace } from "../../../lib/library";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });

  const found = course(id);
  if (!found) return new Response("no such book", { status: 404 });

  // Opening counts as reading: the shelf orders by it.
  if (found.lastUnit) setPlace(id, found.lastUnit);
  return Response.json(found);
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });
  await forget(id);
  return Response.json({ ok: true });
}
