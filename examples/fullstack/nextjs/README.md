# Next.js standalone on a Lambda Web Function

A Next.js 16 app that runs its production standalone server on a Lambda Web Function. Request-time SSR, a server-side
action with validation, client navigation, and hashed chunks served from private S3 behind CloudFront are the
capabilities it demonstrates. It uses no database, login, cache, or persistence.

Status: **local proof only.** Live AWS deployment is not approved and has not run. See "Verification status".

## Pinned versions

| Package | Version | Note |
| --- | --- | --- |
| `next` | `16.4.6` (exact) | Node `>=20.9.0`; the Web Function runtime is Node.js 24. |
| `react`, `react-dom` | `19.3.1` (exact) | Next 16 peers `^19.0.0`. |
| `typescript` | `5.9.3` (exact) | Used by `next build` type checking. |

`bun.lock` pins the full graph. Install with `bun install --frozen-lockfile`.

## Files

- `app/`: `page.tsx` (request-time SSR home page with a client counter and the square form), `about/page.tsx` (second page), `square-form.tsx` and `actions.ts` (a `'use server'` action that validates a number from 0 to 1000 on the server), `counter.tsx` (client state), `probe/identity/route.ts` (smoke-test identity).
- `next.config.mjs`: `output: 'standalone'`, `outputFileTracingRoot` pinned to this directory, and a rewrite of `/__probe/identity` to the route above (Next treats `_`-prefixed folders as private).
- `index.js`: the launcher that becomes the artifact's root `index.js`.
- `build-artifact.mjs`: runs `next build` and stages the artifact root.
- `stack.ts`: the thin CDK composition (a Web Function plus a `WebFunctionDelivery` for `/_next/static/`). It is not deployed.
- `public/robots.txt`: a public file served by the Web Function.

## Build and test

```sh
bun install --frozen-lockfile                 # in examples/fullstack/nextjs
bun run build:artifact                        # native host build, development evidence only
bun test test/fullstack-nextjs.test.ts        # from the repository root; needs the staged artifact
```

`build:artifact` runs `build-native.sh`, which writes to `examples/fullstack/artifacts/nextjs/native-<platform>-<arch>`
(git-ignored). The test suite reads that native directory and fails with the build command if it is missing.

The Linux Arm64 path is `bash examples/fullstack/shared/build-arm64.sh examples/fullstack/nextjs -- node build-artifact.mjs`.
**It has not run.** Docker is unavailable in the development environment, and `build-arm64.sh` refuses to run until its
image digest is pinned. The container image also has no `bun`, so the in-container dependency install step is not yet
defined; `bun install --frozen-lockfile` must run before `build-artifact.mjs` there.

## Launcher contract

`index.js` behaves as follows:

1. Parses `AWS_LAMBDA_HTTP_ENDPOINT` as `host:port`. When the variable is absent (local runs only), it uses `127.0.0.1:3000`. A malformed value, or a port outside 1–65535, exits with an error.
2. Rejects port 0. Next's standalone server maps `PORT=0` to 3000, so an ephemeral port would silently bind the wrong one.
3. Sets `HOSTNAME` and `PORT` **before** requiring the generated `server.js`, because Next reads them at require time.
4. Prints `READY:<port>` once a TCP connection to the endpoint succeeds. A server that fails to bind (for example `EADDRINUSE`) exits the process from Next's own error path.

`/__probe/identity` answers only when `FULLSTACK_PROBE_MARKER` is set, which the probe harness does. In a deployed
invocation it returns 404, so the identity route exposes nothing. Keeping the route in the artifact is the decision
recorded for Task 6's open question.

## Artifact layout

`build-artifact.mjs` stages, without rebundling:

- the complete `.next/standalone` tree: `server.js`, `package.json`, `.next/` server output and manifests, and the traced `node_modules`;
- `.next/static`, which Next does not copy into standalone; it is served by the Web Function too, and uploaded to S3 for CloudFront;
- `public/`, which standalone also omits;
- `index.js`, the launcher.

The native build is about 38 MB unpacked (about 12 MB as a Web Function ZIP). The traced `node_modules` includes the
host's native `sharp` binaries (`@img/sharp-darwin-arm64`), so a native artifact is not deployable to Linux.

## CDK composition

`stack.ts` gives `/_next/static/*` to a private S3 origin, with keys under `_next/static/`, and sends everything else
to the Web Function. The distribution behavior and origin shape are checked by `test/fullstack-nextjs.test.ts`. The
stack is not deployed, and synthesis never runs the framework build.

## Verification status

| Check | Status |
| --- | --- |
| Contract RED (`test/fullstack-nextjs.test.ts`, before implementation) | Recorded in the plan's Task 7 execution record. |
| Contract GREEN (`bun test test/fullstack-nextjs.test.ts`) | 12 pass against the native artifact. |
| Extracted ZIP starts through the probe harness on a non-default port | Passed (test and smoke run). |
| Request-time SSR text in the first HTML, without JavaScript | Passed. |
| Server action validates input and returns a computed result | Passed (valid and invalid values, through the no-JavaScript form path). |
| Client navigation (RSC payload for `/about`) | Passed via a plain fetch. The browser does not run. |
| Hashed chunk under `/_next/static/` with immutable caching | Passed. |
| Linux Arm64 artifact build | **NOT RUN** (no Docker; digest unpinned). |
| Browser hydration, click handling, client-side navigation | **NOT RUN.** No browser runner is in the project. HTML probes cannot prove hydration. |
| Server action origin checks behind CloudFront (`X-Forwarded-Host`) | **Not verified.** The local smoke test has no proxy. |
| CloudFront, S3, Web Function deployment and IAM invocation | **NOT RUN.** Live AWS is not approved. |

## Limits

- No image optimization, ISR or revalidation, cache tags, middleware-dependent behavior, edge runtime, or WebSockets is claimed.
- Retained old `/_next/static/` chunks protect old browser clients from 404s, but do not guarantee that an older browser can call server actions from a previous build after a revision change.
- The launcher does not consume `X-Forwarded-Host`/`X-Forwarded-Proto`; redirect and server-action origin behavior behind CloudFront is unverified.
- `server.js` embeds this build machine's absolute path (`outputFileTracingRoot`, `repoRoot`) in its config. It is not used at runtime on Lambda, but it is present in the artifact.
- Source maps (`.js.map`, about 20 KB) are included, as Next emits them.
