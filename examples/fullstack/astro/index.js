import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
if (!endpoint) {
  console.error(
    "AWS_LAMBDA_HTTP_ENDPOINT is required and must be a host:port address (for example 127.0.0.1:3000).",
  );
  process.exit(1);
}

let url;
try {
  url = new URL(`http://${endpoint}`);
} catch {
  console.error(`AWS_LAMBDA_HTTP_ENDPOINT must be a valid host:port value, received: ${endpoint}`);
  process.exit(1);
}

const port = Number(url.port);
// `url.port === ""` guards a portless value like "not-a-host-port": Number("") is 0, so
// without this check it would pass as port 0 and fail only at listen time (ENOTFOUND).
if (!url.hostname || url.port === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`AWS_LAMBDA_HTTP_ENDPOINT must include a valid TCP port, received: ${endpoint}`);
  process.exit(1);
}

const host = url.hostname;

const rootDir = import.meta.dirname ?? resolve(".");
const clientDir = resolve(rootDir, "dist/client");
const serverEntry = resolve(rootDir, "dist/server/entry.mjs");

const contentTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".map", "application/json; charset=utf-8"],
]);

function tryServeStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false;
  }
  if (pathname.endsWith("/")) return false;
  const candidate = resolve(clientDir, `.${pathname}`);
  if (candidate !== clientDir && !candidate.startsWith(clientDir + "/")) return false;
  if (!existsSync(candidate)) return false;
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = contentTypes.get(extname(candidate).toLowerCase()) ?? "application/octet-stream";
  const headers = { "content-type": type, "content-length": String(stat.size) };
  if (pathname.startsWith("/_astro/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(candidate).pipe(res);
  return true;
}

const mod = await import(pathToFileURL(serverEntry).href);
// Export shape resolved empirically (astro 5.18.2 + @astrojs/node 9.5.5, mode "local"):
// dist/server/entry.mjs exports a READY Node.js (req, res) request handler named `handler`
// (the adapter's createStandaloneHandler: static files from dist/client with the app as
// fallback). It is not a factory and binds no listener — `startServer`/`start` only bind
// in standalone mode, which this example does not use — so this launcher owns the socket.
const handler = typeof mod.handler === "function" ? mod.handler : mod.default?.handler ?? mod.default;
if (typeof handler !== "function") {
  throw new Error(`Astro server entry did not export a request handler: ${serverEntry}`);
}

let actualPort = port;
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    pathname = "";
  }
  if (pathname === "/__probe/identity") {
    const marker = process.env.FULLSTACK_PROBE_MARKER;
    if (!marker) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        framework: "astro",
        artifactRoot: rootDir,
        entry: process.argv[1] ?? null,
        marker,
        port: actualPort,
        renderedAt: new Date().toISOString(),
      }),
    );
    return;
  }
  if (tryServeStatic(req, res)) return;
  handler(req, res);
});

server.listen(port, host, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  if (!Number.isInteger(boundPort) || boundPort <= 0) {
    console.error(`Failed to determine listening port for ${endpoint}`);
    process.exit(1);
  }
  actualPort = boundPort;
  process.env.PORT = String(boundPort);
  console.log(`READY:${boundPort}`);
});

const shutdown = async () => {
  try {
    await new Promise((resolveClose) => server.close(resolveClose));
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
