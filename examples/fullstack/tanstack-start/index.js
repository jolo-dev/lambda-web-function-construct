import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "srvx/node";

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
if (!url.hostname || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`AWS_LAMBDA_HTTP_ENDPOINT must include a valid TCP port, received: ${endpoint}`);
  process.exit(1);
}

const host = url.hostname;
process.env.HOST = host;
process.env.HOSTNAME = host;
process.env.PORT = String(port);

const rootDir = import.meta.dirname ?? resolve(".");
const clientDir = resolve(rootDir, "dist/client");
const serverEntry = resolve(rootDir, "dist/server/server.js");

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

function tryServeStatic(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith("/")) return null;
  const candidate = resolve(clientDir, `.${pathname}`);
  if (candidate !== clientDir && !candidate.startsWith(clientDir + "/")) return null;
  if (!existsSync(candidate)) return null;
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const type = contentTypes.get(extname(candidate).toLowerCase()) ?? "application/octet-stream";
  const headers = new Headers({ "content-type": type, "content-length": String(stat.size) });
  if (pathname.startsWith("/assets/")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(createReadStream(candidate), { status: 200, headers });
}

const mod = await import(pathToFileURL(serverEntry).href);
const appFetch = mod.fetch ?? mod.default?.fetch ?? mod.default;
if (typeof appFetch !== "function") {
  throw new Error(`TanStack Start server entry did not export a fetch handler: ${serverEntry}`);
}

const fetch = async (request) => {
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = "";
  }
  if (pathname === "/__probe/identity") {
    const marker = process.env.FULLSTACK_PROBE_MARKER;
    if (!marker) return new Response("Not found", { status: 404 });
    return Response.json({
      framework: "tanstack-start",
      artifactRoot: rootDir,
      entry: process.argv[1] ?? null,
      marker,
      port: Number(process.env.PORT),
      renderedAt: new Date().toISOString(),
    });
  }
  const staticResponse = tryServeStatic(request);
  if (staticResponse) return staticResponse;
  return appFetch(request);
};

const server = await serve({ fetch, hostname: host, port, silent: true });
if (typeof server.ready === "function") {
  await server.ready();
} else if (typeof server.serve === "function") {
  await server.serve();
}
const address = server.node?.server?.address?.() ?? server.address;
const actualPort = typeof address === "object" && address ? address.port : port;
if (!Number.isInteger(actualPort) || actualPort <= 0) {
  throw new Error(`Failed to determine listening port for ${endpoint}`);
}
process.env.PORT = String(actualPort);
console.log(`READY:${actualPort}`);

const shutdown = async () => {
  try {
    await server.close?.();
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
