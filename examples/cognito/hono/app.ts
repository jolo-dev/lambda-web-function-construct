import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthenticatedUser } from "../shared/auth";
import { corsPolicy, type ApiOptions } from "../shared/http";

export function createHonoServer(options: ApiOptions) {
  const app = new Hono<{ Variables: { user: AuthenticatedUser } }>();

  app.use("*", async (c, next) => {
    const policy = corsPolicy({
      method: c.req.method,
      origin: c.req.header("Origin"),
      requestedMethod: c.req.header("Access-Control-Request-Method"),
      requestedHeaders: c.req.header("Access-Control-Request-Headers"),
    }, options.frontendOrigin);
    for (const [key, value] of Object.entries(policy.headers)) c.header(key, value);
    if (policy.preflightStatus === 204) return c.body(null, 204);
    if (policy.preflightStatus === 403) return c.json({ error: "Forbidden" }, 403);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  const protectedRoute = createMiddleware<{ Variables: { user: AuthenticatedUser } }>(async (c, next) => {
    const user = await options.authenticate(c.req.header("Authorization"));
    if (!user) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  });

  app.get("/me", protectedRoute, (c) => c.json(c.get("user")));
  app.get("/admin", protectedRoute, (c) => {
    const user = c.get("user");
    if (!user.groups.includes("admins")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ userId: user.userId, message: "Admin access granted" });
  });
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  app.onError((_error, c) => c.json({ error: "Internal server error" }, 500));

  // Keep Node's native Fetch API globals intact (also permits Bun-based local tests).
  return createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
}
