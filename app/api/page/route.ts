import { pages } from "../../../lib/library";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const book = params.get("book");
  const page = Number(params.get("page"));
  if (!book || !page) return new Response("book and page required", { status: 400 });

  // The reader asks for a sharper render as it zooms in, in whole steps so the
  // browser cache still hits. Clamped because scale is a canvas allocation.
  const scale = Math.min(4, Math.max(1, Math.round(Number(params.get("scale")) || 2)));

  const opening = pages(book);
  if (!opening) return new Response("no such book", { status: 404 });

  const pdf = await opening;
  if (page < 1 || page > pdf.pageCount) return new Response("out of range", { status: 404 });

  return new Response(new Uint8Array(await pdf.render(page, scale)), {
    headers: {
      "content-type": "image/png",
      // Pages never change for a given file; let the browser keep them.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
