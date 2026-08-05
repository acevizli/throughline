import { ingest } from "../../../lib/library";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const path = params.get("path");
  const page = Number(params.get("page"));
  if (!path || !page) return new Response("path and page required", { status: 400 });

  const { book } = await ingest(path);
  if (page < 1 || page > book.pageCount) return new Response("out of range", { status: 404 });

  const png = await book.renderPage(page);
  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      // Pages never change for a given file; let the browser keep them.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
