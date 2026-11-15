import { createServer } from "node:http";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { corsPolicy, type ApiOptions } from "../shared/http";

export function createExpressServer(options: ApiOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((req, res, next) => {
    const policy = corsPolicy({
      method: req.method,
      origin: req.get("Origin"),
      requestedMethod: req.get("Access-Control-Request-Method"),
      requestedHeaders: req.get("Access-Control-Request-Headers"),
    }, options.frontendOrigin);
    res.set(policy.headers);
    if (policy.preflightStatus !== undefined) {
      res.status(policy.preflightStatus).end();
      return;
    }
    next();
  });

  const protectedRoute: RequestHandler = async (req, res, next) => {
    const user = await options.authenticate(req.get("Authorization"));
    if (!user) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.user = user;
    next();
  };

  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.get("/me", protectedRoute, (_req, res) => { res.json(res.locals.user); });
  app.get("/admin", protectedRoute, (_req, res) => {
    const user = res.locals.user;
    if (!user.groups.includes("admins")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json({ userId: user.userId, message: "Admin access granted" });
  });
  app.use((_req, res) => { res.status(404).json({ error: "Not Found" }); });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);
  return createServer(app);
}
