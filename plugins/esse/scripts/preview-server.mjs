import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.ESSE_PREVIEW_PORT || 8791);
const htmlPath = path.join(process.cwd(), "web", "preview.html");
const server = createServer(async (_request, response) => {
  try {
    const html = await readFile(htmlPath);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Development-only widget preview: http://127.0.0.1:${port}`));
