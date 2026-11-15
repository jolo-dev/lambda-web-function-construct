import { createServer, type ServerResponse } from "node:http";
import { corsPolicy, type ApiOptions } from "../shared/http";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createNodeServer(options: ApiOptions) {
  return createServer(async (req, res) => {
    try {
      const policy = corsPolicy({
        method: req.method ?? "GET",
        origin: req.headers.origin,
        requestedMethod: req.headers["access-control-request-method"] as string | undefined,
        requestedHeaders: req.headers["access-control-request-headers"] as string | undefined,
      }, options.frontendOrigin);
      for (const [key, value] of Object.entries(policy.headers)) res.setHeader(key, value);
      if (policy.preflightStatus !== undefined) {
        res.writeHead(policy.preflightStatus);
        res.end();
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method !== "GET" || !["/me", "/admin"].includes(pathname)) {
        json(res, 404, { error: "Not Found" });
        return;
      }
      const user = await options.authenticate(req.headers.authorization);
      if (!user) {
        res.setHeader("WWW-Authenticate", "Bearer");
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      if (pathname === "/admin") {
        if (!user.groups.includes("admins")) {
          json(res, 403, { error: "Forbidden" });
          return;
        }
        json(res, 200, { userId: user.userId, message: "Admin access granted" });
        return;
      }
      json(res, 200, user);
    } catch {
      json(res, 500, { error: "Internal server error" });
    }
  });
}
