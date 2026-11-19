# TanStack Start on Lambda Web Functions

This example demonstrates a production TanStack Start server on `WebFunction` with optional `WebFunctionDelivery` for immutable client assets.

## Pinned versions

- `@tanstack/react-start` `1.169.5` (exact)
- `@tanstack/react-router` `1.170.46` (aligned with react-start dependencies)
- `vite` `^8.0.0` resolved in `bun.lock`
- `react` / `react-dom` `19.2.5`
- `srvx` (transitive via start plugin; used by the launcher to serve the fetch handler)

Requires Node `>=22.12.0` (react-start engine). Local verification used Node 24.

## Discovered production contract (pinned build)

`bun run build` (`vite build` with `@tanstack/react-start/plugin/vite`) produces:

- `dist/server/server.js` – SSR/server entry exporting a default `{ fetch }` handler (not a self-listening Node server).
- `dist/client/assets/*` – content-hashed client bundles referenced as `/assets/<hash>.js`.
- `dist/client/robots.txt` (and other `public/` files) – mutable/unhashed public files in the client output.

The Web Function launcher (`index.js`) parses `AWS_LAMBDA_HTTP_ENDPOINT`, serves static files from `dist/client` as a local convenience, and uses `srvx/node` `serve()` to run the exported fetch handler on the provided host:port. In production, CloudFront routes `/assets/*` to S3; dynamic paths go to the Web Function.

Server-side behavior is implemented with TanStack Start route `server.handlers` (native server routes), including a validating mutation at `/api/square`, native auth endpoints at `/api/login`, `/api/logout`, and `/api/session` (see below), and a probe-only identity route at `/__probe/identity` (returns 404 unless `FULLSTACK_PROBE_MARKER` is set).

## Demo basic-auth session (stateless)

This example adds a stateless basic-auth flow to demonstrate a session-gated route on a Web Function:

- `POST /api/login` (native server route) validates the posted credentials against the single demo user and, on success, writes an `iron-session` cookie (`app-session`, HTTP-only, `sameSite=lax`, `secure` in production, 7-day TTL). `GET /api/session` returns the signed-in email (or `{}`). `POST /api/logout` destroys the session and clears the cookie.
- Demo credentials: `demo@example.com` / `demo-password` (shown on the `/login` page). Bad credentials get `401 Invalid email or password`.
- `/profile` is protected by the `_authed` layout route's `beforeLoad` guard: unauthenticated requests render the login panel instead of the profile. `NODE_ENV=production` on the Web Function makes the session cookie `secure`.
- **Stateless logout:** logout only clears the browser cookie. A cookie copied before logout remains valid server-side until the 7-day TTL; there is no server-side session store to revoke.
- **Demo-only auth:** there is no database and no user store — one hardcoded demo user checked with a SHA-256 digest comparison that mirrors the upstream starter. Never use this pattern for real credentials.

### Session secret at synthesis

`stack.ts` passes `SESSION_PASSWORD` (≥32 characters) to the Web Function. Synthesis reads it from the `FULLSTACK_SESSION_PASSWORD` environment variable via `shared/session-secret.ts` in the shared `examples/fullstack/cdk-app.ts` deploy entry. Because all three example stacks (Next.js, Nuxt, TanStack Start) are synthesized by that one entry, a missing or too-short `FULLSTACK_SESSION_PASSWORD` fails the entire synthesis — no example stack can be synthesized without it.

```sh
FULLSTACK_SESSION_PASSWORD="<at least 32 characters>" <cdk synth/deploy command>
```

The local probe tests cover the login page reachability, credential rejection/acceptance, the protected profile, logout cookie clearing, the stateless-replay caveat, and the stack's session-secret and production-cookie wiring.

## Build and stage

```bash
cd examples/fullstack/tanstack-start
bun install --frozen-lockfile
bun run build:artifact
```

`build:artifact` runs the production build and stages the complete `dist/` tree plus `index.js` into `../artifacts/tanstack-start/<name>` (default `native-darwin-arm64`). The artifact preserves the server and client outputs without rebundling.

## Local smoke proof

```bash
bun test test/fullstack-tanstack-start.test.ts
```

The test synthesizes the stack (with a test session password), extracts the Lambda ZIP, resolves literal runtime `require()` paths, and runs the extracted artifact through `examples/fullstack/shared/probe.ts` on a non-default port. It verifies SSR HTML, native server mutation validation, native auth endpoints (login reject/accept, protected `/profile`, logout), navigation reachability, hashed client asset serving, mutable public file serving, and the session-secret stack wiring. 19 tests.

## CDK routing

`stack.ts` composes `WebFunction` (IAM-protected) with `WebFunctionDelivery`:

- `/_next/static/*` equivalent for this app is `/assets/*` → S3 origin from `dist/client/assets` (immutable).
- All other paths → Web Function (dynamic).
- `SESSION_PASSWORD` (from `FULLSTACK_SESSION_PASSWORD` at synthesis) and `NODE_ENV=production` are set as Web Function revision environment variables.

## Limitations and unverified behavior

- **Linux Arm64 artifact proof is local plus bounded live.** The current artifact (including the basic-auth routes) was rebuilt in a pinned `linux/arm64` Node 24.22.1 container (Bun 1.4.4, frozen lockfile), with ARM aarch64 native modules and `node_modules/iron-session` present. It has not been live-verified with auth. A bounded live `FullstackTanStackStart` deployment (pre-auth artifact) in `eu-central-1` passed SSR, navigation, native mutation, asset, and cache-key probes before full cleanup.
- **No browser hydration/click proof in this task.** HTTP and RSC-like navigation checks only; full browser interaction not verified.
- **Streaming:** the server uses `defaultStreamHandler`; incremental streaming delivery to CloudFront/Lambda was not separately measured.
- Does not demonstrate ISR/cache consistency, deployment-skew-safe old server actions, image optimization, edge runtime, WebSockets, or multi-region behavior.
- The revised 1-second `KEYALL` cache policy (Authorization + all cookies + all query strings) was accepted and verified live; the original zero-TTL policy was rejected. See `docs/superpowers/plans/2026-11-18-fullstack-preflight.md` for the TanStack live results.
