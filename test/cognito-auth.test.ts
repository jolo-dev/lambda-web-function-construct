import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Server } from "node:http";
import { createCognitoAuth } from "../examples/cognito/shared/auth";
import { readConfiguration } from "../examples/cognito/shared/config";
import { createHonoServer } from "../examples/cognito/hono/app";
import { createExpressServer } from "../examples/cognito/express/app";
import { createNodeServer } from "../examples/cognito/node-http/app";

const poolId = "eu-central-1_TestPool";
const clientId = "test-client";
const issuer = `https://cognito-idp.eu-central-1.amazonaws.com/${poolId}`;
const origin = "http://localhost:5173";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-test-key", alg: "RS256", use: "sig" };
const auth = createCognitoAuth({ userPoolId: poolId, clientId });
auth.verifier.cacheJwks({ keys: [jwk] });

function token(overrides: Record<string, unknown> = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, sub: "verified-user", client_id: clientId, token_use: "access",
    iat: now, exp: now + 300, scope: "openid profile email", ...overrides,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), signingKey).toString("base64url")}`;
}

const invalidHeaders = [
  undefined,
  "Basic abc",
  "Bearer",
  "Bearer not-a-jwt",
  `Bearer ${token({ exp: 1 })}`,
  `Bearer ${token({ client_id: "other-client" })}`,
  `Bearer ${token({ iss: "https://attacker.example.com" })}`,
  `Bearer ${token({ token_use: "id", aud: clientId })}`,
  `Bearer ${token({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)}`,
  `Bearer ${token()} extra`,
];

test("verifies real signatures and returns only verified identity/groups", async () => {
  expect(await auth.authenticate(`Bearer ${token()}`)).toEqual({ userId: "verified-user", groups: [] });
  expect(await auth.authenticate(`bearer ${token({ "cognito:groups": ["admins"] })}`))
    .toEqual({ userId: "verified-user", groups: ["admins"] });
});

test.each(invalidHeaders)("rejects missing, forged, expired or inappropriate access tokens (%#)", async (header) => {
  expect(await auth.authenticate(header)).toBeNull();
});

test("runtime configuration fails closed rather than running without Cognito", () => {
  expect(() => readConfiguration({})).toThrow(/COGNITO_USER_POOL_ID/);
  expect(() => readConfiguration({ COGNITO_USER_POOL_ID: poolId })).toThrow(/COGNITO_CLIENT_ID/);
  expect(() => readConfiguration({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId })).toThrow(/FRONTEND_ORIGIN/);
  expect(() => readConfiguration({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId, FRONTEND_ORIGIN: "*" })).toThrow(/origin/i);
  expect(() => readConfiguration({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId, FRONTEND_ORIGIN: "https://example.com/path" })).toThrow(/origin/i);
  expect(() => readConfiguration({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId, FRONTEND_ORIGIN: "http://example.com" })).toThrow(/origin/i);
  expect(readConfiguration({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId, FRONTEND_ORIGIN: origin }))
    .toEqual({ userPoolId: poolId, clientId, frontendOrigin: origin });
});

test("Hono server creation does not replace global Fetch API constructors", () => {
  const response = globalThis.Response;
  const request = globalThis.Request;
  createHonoServer({ authenticate: auth.authenticate, frontendOrigin: origin });
  expect(globalThis.Response).toBe(response);
  expect(globalThis.Request).toBe(request);
});

async function withServer(factory: () => Server, run: (url: string) => Promise<void>) {
  const server = factory();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

for (const [name, factory] of [
  ["hono", createHonoServer],
  ["express", createExpressServer],
  ["node-http", createNodeServer],
] as const) {
  describe(`${name} Cognito API`, () => {
    const start = (run: (url: string) => Promise<void>) => withServer(
      () => factory({ authenticate: auth.authenticate, frontendOrigin: origin }), run,
    );

    test("public health and protected user identity work over HTTP", () => start(async url => {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      const response = await fetch(`${url}/me?userId=attacker`, {
        headers: { authorization: `Bearer ${token()}`, origin },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: "verified-user", groups: [] });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${url}/unknown`)).status).toBe(404);
    }));

    test("all invalid credentials fail closed without exposing details", () => start(async url => {
      for (const authorization of invalidHeaders) {
        const response = await fetch(`${url}/me`, { headers: authorization ? { authorization, origin } : { origin } });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
    }));

    test("authenticated users need the admins group for the admin route", () => start(async url => {
      expect((await fetch(`${url}/admin`, { headers: { authorization: `Bearer ${token()}` } })).status).toBe(403);
      const response = await fetch(`${url}/admin`, {
        headers: { authorization: `Bearer ${token({ "cognito:groups": ["admins"] })}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: "verified-user", message: "Admin access granted" });
    }));

    test("preflight permits only the configured origin, method and headers without a token", () => start(async url => {
      const preflight = (extra: Record<string, string> = {}) => fetch(`${url}/me`, {
        method: "OPTIONS", headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization, content-type",
          ...extra,
        },
      });
      const response = await preflight();
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
      expect((await preflight({ origin: "https://attacker.example.com" })).status).toBe(403);
      expect((await preflight({ "access-control-request-method": "DELETE" })).status).toBe(403);
      expect((await preflight({ "access-control-request-headers": "x-untrusted" })).status).toBe(403);
      const deniedOrigin = await fetch(`${url}/me`, { headers: { origin: "https://attacker.example.com" } });
      expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();
    }));
  });
}
