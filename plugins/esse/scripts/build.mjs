import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const mcpDir = path.join(root, "mcp");
await mkdir(mcpDir, { recursive: true });

const widgetResult = await build({
  entryPoints: [path.join(root, "web", "main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  write: false,
  outdir: mcpDir,
  entryNames: "widget",
  loader: { ".svg": "dataurl" }
});

const javascript = widgetResult.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const css = widgetResult.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
if (!javascript) throw new Error("Widget build produced no JavaScript output.");

const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div id="root"></div><script type="module">${javascript}</script></body>
</html>`;
await writeFile(path.join(mcpDir, "widget.html"), html, "utf8");

await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node20"],
  outfile: path.join(mcpDir, "server.cjs"),
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" }
});

const previewTemplate = await readFile(path.join(root, "web", "preview.template.html"), "utf8");
await writeFile(
  path.join(root, "web", "preview.html"),
  previewTemplate.replace("/*__WIDGET_CSS__*/", css).replace("/*__WIDGET_JS__*/", javascript),
  "utf8"
);

console.log("Built mcp/server.cjs, mcp/widget.html, and web/preview.html");
