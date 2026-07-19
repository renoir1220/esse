import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.ESSE_PREVIEW_PORT || 8791);
const htmlPath = path.join(process.cwd(), "web", "preview.html");
const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/fixture-image") {
      const source = new URL(requestUrl.searchParams.get("url") || "");
      if (source.protocol !== "https:" || source.hostname !== "images.unsplash.com") throw new Error("Unsupported preview fixture URL");
      const upstream = await fetch(source, { headers: { "user-agent": "esse-local-preview" } });
      if (!upstream.ok) throw new Error(`Preview fixture request failed: ${upstream.status}`);
      response.writeHead(200, { "content-type": upstream.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=3600" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const html = await readFile(htmlPath);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Development-only widget preview: http://127.0.0.1:${port}`));
