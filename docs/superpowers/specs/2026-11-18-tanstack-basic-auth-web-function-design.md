# TanStack Start basic-auth starter on Lambda Web Functions

Date: 2026-11-18
Status: Approved in conversation; implementation and a new live rollout are not yet authorized.

## Goal

Replace the current stateless TanStack Start Web Function demo's application code with the auth architecture of
[`TanStack/router/examples/react/start-basic-auth`](https://github.com/TanStack/router/tree/main/examples/react/start-basic-auth),
without adopting its database. The example must still build as a pinned TanStack Start production server, run behind
the existing Web Function launcher and `WebFunctionDelivery`, and pass local and bounded live probes before a new
live deployment is considered complete.

This is a demo of the starter's **session and protected-route pattern on Web Functions**, not a production auth
system. No Cognito, real user store, or multi-user accounts are introduced.

## Approved decisions

- **Approach A:** port the starter's auth structure but keep this example's existing pinned framework versions. Add
  `iron-session@^9` only; do not add Prisma, LibSQL/SQLite, Tailwind, router devtools, the posts page, or external
  API calls.
- Keep `@tanstack/react-start@1.169.5`, `@tanstack/react-router@1.170.46`, React/ReactDOM `19.2.5`, Vite 8, and the
  existing `bun.lock` update path.
- Replace Prisma with one hardcoded demo user. Keep the starter's SHA-256 password-comparison shape as a
  demo-only convention, not real credential storage.
- Replace the starter's signup flow with login/logout only; there is no database in which to create users.
- Keep the existing SSR home page, `/about`, native `/api/square` mutation, `/__probe/identity`, hashed `/assets/*`
  S3 routing, launcher, artifact staging, and CDK composition.
- The new live rollout uses the already approved `TTL1`/`KEYALL` cache policy: 1-second cache with `Authorization`,
  all cookies, and all query strings in the key.
- After live verification, clean up the new stack and all deployment assets (operator confirmed cleanup on 2026-11-18).

## Architecture and components

All application changes stay inside `examples/fullstack/tanstack-start/`. `src/web-function.ts`,
`src/web-function-delivery.ts`, the shared probe harness, and the root CDK app are unchanged except for the new
stack environment wiring described below.

| File | Responsibility |
| --- | --- |
| `src/utils/session.ts` | Adapted `getAppSession()`: `getIronSession` with `getCookie`/`setCookie` from `@tanstack/react-start/server`, cookie name `app-session`, 7-day TTL, `httpOnly`, `sameSite: "lax"`, `secure` when `NODE_ENV=production`. Requires `SESSION_PASSWORD` of at least 32 characters. No Prisma import. |
| `src/utils/demo-user.ts` | Single public demo user (`demo@example.com` / `demo-password`). Exposes a SHA-256 digest comparison helper. Clearly documented as demo-only. |
| `src/routes/__root.tsx` | Keeps the current document shell and adds a `fetchUser` server function that reads the session and puts `{ user }` in route context. |
| `src/routes/login.tsx` | Public login page and `loginFn` server function. Valid credentials set `session.userEmail` and call `session.save()`; invalid credentials return the starter-style `{ error: true, message }`. Thin native `/api/login`, `/api/logout`, and `/api/session` server routes delegate to the same session helpers so the flow can be probed without a browser; the login panel submits JSON to `/api/login`. |
| `src/routes/logout.tsx` | `logoutFn` destroys the session and redirects to `/`, matching the starter. |
| `src/routes/_authed.tsx` | Pathless protected layout. `beforeLoad` throws `Not authenticated` when `context.user` is absent; `errorComponent` renders the login UI for that error. |
| `src/routes/_authed/profile.tsx` | Protected page that displays the authenticated demo email. |
| `src/routes/index.tsx` | Public home page: retains request-time SSR timestamp, client counter, `/api/square` mutation form, and a link to login/profile. |
| `src/routes/about.tsx`, `src/routes/api.square.ts`, and the launcher's `/__probe/identity` behavior | Existing behavior retained. The probe identity is served by `index.js`, not by a route file. |
| `stack.ts` | Adds `environmentVariables: { SESSION_PASSWORD: ..., NODE_ENV: "production" }` to the `WebFunction`. Values come from synth-time environment, not source files. |
| `examples/fullstack/cdk-app.ts` | Reads `FULLSTACK_SESSION_PASSWORD` from the deploy shell, validates length ≥32, and passes it to `TanStackStartExampleStack`; fails synthesis with a clear error if absent. This gates all three example stacks in the shared CDK app, which is acceptable for this demo but should be documented in the README. |

Data flow: login form → `loginFn` → demo user digest check → `session.save()` writes encrypted `app-session` cookie →
subsequent request root `fetchUser` reads cookie into route context → `_authed` guard admits `/profile` or renders
login. Logout destroys the cookie and redirects.

## Secret and cookie handling

- `SESSION_PASSWORD` is supplied only at synth/deploy via `FULLSTACK_SESSION_PASSWORD`. It must be ≥32 characters.
  It is stored in the Lambda Web Function configuration as a plain environment variable; this is acceptable for a
  disposable demo but is **not** a production secret-management pattern and must be documented as such.
- Local tests pass a fixed ≥32-character test value through the probe harness `env` option; no secret is committed.
- `NODE_ENV=production` is set explicitly in the Web Function environment so the session cookie is emitted with
  `Secure`, which is required because CloudFront serves HTTPS.
- The demo password is public by design. SHA-256 is used only to mirror the starter's code path, not to provide
  secure password storage.
- Cookie isolation at the edge relies on KEYALL: `app-session` is part of the CloudFront cache key, so different
  sessions cannot share a cached response. The 1-second TTL is unchanged.

## Error handling

- Missing or short `SESSION_PASSWORD` fails synth with an explicit error, and any request-time session access fails
  loudly rather than falling back to an insecure cookie.
- Invalid login returns `{ error: true, message: "..." }` and renders the message on the login page.
- Unauthenticated access to `/profile` renders the login UI via the `_authed` error component rather than a raw error.
- Logout always destroys the session and redirects to `/`; subsequent `/profile` access requires login again.

## Testing

The assertions in `test/fullstack-tanstack-start.test.ts` remain (staged artifact layout, synthesis, extracted ZIP
startup, SSR, `/api/square` valid/invalid, navigation, hashed asset, mutable public file, probe identity, launcher
endpoint/error cases), but the harness must be updated: construct `TanStackStartExampleStack` with the new session
password input, and pass `SESSION_PASSWORD`/`NODE_ENV=production` through `startServer`'s `env` option. Add:

- synthesis asserts `SESSION_PASSWORD` and `NODE_ENV=production` environment variables and a rejection for a
  missing/short secret;
- login page reachable and shows the public demo credentials for the demo;
- invalid login shows an error and does not set `app-session`;
- valid login sets `app-session` with `HttpOnly`, `Secure`, and `SameSite=Lax`, and authenticated `/profile` shows
  the demo email;
- unauthenticated `/profile` renders the login UI;
- logout clears access and a subsequent `/profile` request renders login again.

Rebuild the Linux Arm64 artifact after adding `iron-session`, re-run the focused contract test and full suite, and
re-run JSII/type checks before any live action.

## Live deployment gate and acceptance

The earlier live gate approvals (profile `jolo`, account `246350246460`, region `eu-central-1`, stack
`FullstackTanStackStart`, ≤100 bounded requests, ≤10 min propagation wait, stop on unexpected failure) apply to this
new rollout only after this design and its implementation plan are approved. The deploy command remains:

```sh
FULLSTACK_SESSION_PASSWORD=<32+ chars> \
AWS_PROFILE=jolo AWS_REGION=eu-central-1 \
CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \
bunx cdk deploy FullstackTanStackStart \
  --app 'bun run examples/fullstack/cdk-app.ts' --require-approval never
```

Acceptance checks through CloudFront: unsigned direct endpoint 403; SSR; `/about`; `/api/square` valid/invalid;
hashed `/assets/*` with immutable headers; `robots.txt`; probe identity 404 without the marker; login page; invalid
login error; valid login `Set-Cookie` attributes; authenticated and unauthenticated `/profile`; logout; KEYALL
cache-key behavior (distinct Authorization/cookie/query Miss, exact repeat Hit within 1 second). Record distributions,
URLs, status codes, headers, and results.

After verification, destroy `FullstackTanStackStart`, delete the bootstrap asset objects uploaded for that
deployment, and verify the stack, distribution, buckets, and objects are gone. Do not run any AWS action before the
design/plan gates are complete.

## Risks and limitations

- `iron-session` adds a runtime dependency to the artifact; the arm64 build must include it and startup must be
  re-verified from the extracted ZIP.
- Encrypted session cookies are stateless, so no database is needed, but rotating `SESSION_PASSWORD` invalidates all
  sessions. The demo does not require session continuity across deployments.
- The SHA-256 demo password check is intentionally insecure and must not be presented as production auth.
- Browser hydration/click behavior, streaming timing, and two-build old-asset retention remain unverified unless a
  separate check is added.
- CloudFront Functions still use `x-public-host`/`x-public-proto`; no example consumes them, so public-origin
  redirect behavior remains unverified.
