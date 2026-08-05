import { ingest } from "../../../lib/library";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const path = params.get("path");
  if (!path) return new Response("path required", { status: 400 });

  const minutes = Number(params.get("minutes")) || undefined;
  try {
    const { course } = await ingest(path, minutes);
    return Response.json(course);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
