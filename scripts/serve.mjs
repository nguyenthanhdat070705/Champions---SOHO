import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const siteRoot = join(projectRoot, "site");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.HOST ?? "127.0.0.1";

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = resolve(siteRoot, requested || "index.html");
  const withinSite = relative(siteRoot, candidate);

  if (withinSite.startsWith(`..${sep}`) || withinSite === "..") {
    return null;
  }

  return candidate;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    let filePath = safePath(url.pathname);

    if (!filePath) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    let fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = join(filePath, "index.html");
      fileStats = await stat(filePath);
    }

    if (!fileStats.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Length": fileStats.size,
      "Content-Type": mimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    response.writeHead(status).end(status === 404 ? "Not found" : "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Hallmark preview: http://${host}:${port}`);
});
