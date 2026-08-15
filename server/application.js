import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import createPaymentHandler from "../api/payos/create-payment.js";
import paymentHandler from "../api/payos/payment.js";
import webhookHandler from "../api/payos/webhook.js";
import { handleF3Request } from "./f3/router.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// The SPA build output. In production `npm run build` emits the Vite bundle to
// dist/, and this combined server serves it while also hosting the PayOS API.
const defaultSiteRoot = join(projectRoot, "dist");
const maxBodyBytes = 1024 * 1024;

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const apiRoutes = new Map([
  ["/api/payos/create-payment", createPaymentHandler],
  ["/api/payos/payment", paymentHandler],
  ["/api/payos/webhook", webhookHandler],
]);

function normalizeRoutePath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function safeStaticPath(siteRoot, pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = resolve(siteRoot, requested || "index.html");
  const withinSite = relative(siteRoot, candidate);

  if (withinSite === ".." || withinSite.startsWith(`..${sep}`)) return null;
  return candidate;
}

function queryObject(searchParams) {
  const query = {};

  for (const [key, value] of searchParams) {
    if (query[key] === undefined) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      query[key].push(value);
    } else {
      query[key] = [query[key], value];
    }
  }

  return query;
}

function enhanceResponse(response) {
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };

  response.json = function json(body) {
    if (!this.hasHeader("Content-Type")) {
      this.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    this.end(JSON.stringify(body));
    return body;
  };
}

async function readRequestBody(request) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > maxBodyBytes) {
    const error = new Error("Request body is too large");
    error.code = "PAYLOAD_TOO_LARGE";
    throw error;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body is too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

function sendHealth(response) {
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      status: "ok",
      service: "soho-payos",
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );
}

async function sendFile(request, response, filePath, statusCode = 200) {
  const fileStats = await stat(filePath);
  response.writeHead(statusCode, {
    "Content-Length": fileStats.size,
    "Content-Type":
      mimeTypes.get(extname(filePath).toLowerCase()) ||
      "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

// SPA fallback: unknown navigations (paths without a file extension) get the
// built index.html so client-side routing works on deep links / refresh.
// Requests that look like missing assets (they have an extension) stay 404.
async function serveSpaFallback(request, response, siteRoot, pathname) {
  if (extname(pathname)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const indexPath = join(siteRoot, "index.html");
  try {
    await sendFile(request, response, indexPath, 200);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

async function serveStaticFile(request, response, siteRoot, pathname) {
  const filePath = safeStaticPath(siteRoot, pathname);
  if (!filePath) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await serveSpaFallback(request, response, siteRoot, pathname);
      return;
    }
    throw error;
  }

  if (fileStats.isDirectory()) {
    const indexPath = join(filePath, "index.html");
    try {
      await sendFile(request, response, indexPath, 200);
    } catch {
      await serveSpaFallback(request, response, siteRoot, pathname);
    }
    return;
  }

  if (!fileStats.isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }

  await sendFile(request, response, filePath, 200);
}

export function createApplicationServer({ siteRoot = defaultSiteRoot } = {}) {
  return createServer(async (request, response) => {
    enhanceResponse(response);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    try {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );
      const pathname = normalizeRoutePath(url.pathname);

      if (pathname === "/health") {
        if (!["GET", "HEAD"].includes(request.method)) {
          response.setHeader("Allow", "GET, HEAD");
          response.writeHead(405).end("Method not allowed");
          return;
        }
        sendHealth(response);
        return;
      }

      const apiHandler = apiRoutes.get(pathname);
      if (apiHandler) {
        request.query = queryObject(url.searchParams);
        if (!["GET", "HEAD"].includes(request.method)) {
          request.body = await readRequestBody(request);
        }

        await apiHandler(request, response);
        if (!response.writableEnded) response.end();
        return;
      }

      // Functional 03 API (server-side money/inventory paths). The router reads
      // its own body from the untouched stream and sends the response itself.
      if (pathname.startsWith("/v1/")) {
        const handled = await handleF3Request(request, response, url);
        if (handled) {
          if (!response.writableEnded) response.end();
          return;
        }
      }

      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        response.writeHead(405).end("Method not allowed");
        return;
      }

      await serveStaticFile(request, response, siteRoot, url.pathname);
    } catch (error) {
      if (response.writableEnded) return;

      if (error?.code === "ENOENT") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (error?.code === "PAYLOAD_TOO_LARGE") {
        response.writeHead(413).end("Request body is too large");
        return;
      }
      if (error instanceof URIError) {
        response.writeHead(400).end("Bad request");
        return;
      }

      console.error("Application server error", error);
      response.writeHead(500).end("Server error");
    }
  });
}

export function startApplicationServer({
  defaultHost = "0.0.0.0",
  defaultPort = 3000,
  label = "SOHO",
} = {}) {
  const host = process.env.HOST || defaultHost;
  const port = Number.parseInt(process.env.PORT || String(defaultPort), 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const server = createApplicationServer();
  server.listen(port, host, () => {
    console.log(`${label} listening on http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received; shutting down`);
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return server;
}
