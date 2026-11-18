# Nuxt 4 (Nitro node-server) on a Lambda Web Function

A Nuxt 4 app running Nitro's production Node server preset on a Lambda Web Function. It demonstrates request-time SSR, client navigation/hydration code paths, a native Nitro server mutation with validation, and hashed client assets served from private S3 behind CloudFront. It uses no database, login, cache, or persistence.

Status: **local proof only.** Live AWS deployment is not approved and has not run. Linux Arm64 Docker build proof and browser hydration verification are **NOT RUN** in this session.

## Pinned versions

| Package | Version | Note |
| --- | --- | --- |
| `nuxt` | `4.6.4` (exact) | Nitro node-server preset (`nitro.preset: "node-server"`). Node 24 compatible per Nuxt 4 engine range (gate documented in preflight). |
| `vue` | `3.5.32` (exact) | Nuxt 4 peer-aligned. |
| `vue-router` | `5.0.4` (exact) | Nuxt 4 routing dependency. |
| `typescript` | `5.9.3` (exact) | Dev tooling. |

`bun.lock` pins the full graph. Install with `bun install --frozen-lockfile`.

## Files

- `app/pages/index.vue`: request-time SSR page (server timestamp in initial HTML), client counter, and a server-mutation form component.
- `app/pages/about.vue`: second page for client navigation.
- `app/components/SquareForm.vue`: posts to a native Nitro server route.
- `server/api/square.post.ts`: Nitro server mutation with server-side validation (whole number 0–1000).
- `server/routes/__probe/identity.get.ts`: probe identity route, returns 404 when `FULLSTACK_PROBE_MARKER` is absent.
- `public/robots.txt`: static public file served dynamically.
- `nuxt.config.ts`: explicit `nitro.preset: "node-server"`.
- `index.js`: root launcher; maps `AWS_LAMBDA_HTTP_ENDPOINT` to `HOST/PORT` and `NITRO_HOST/NITRO_PORT` before importing the built Nitro entry.
- `build-artifact.mjs`: runs `nuxt build` and stages the complete `.output` tree plus `index.js`.
- `stack.ts`: thin CDK composition (Web Function + `WebFunctionDelivery` mapping `/_nuxt/` to S3).

## Build and test

```sh
bun install --frozen-lockfile                 # in examples/fullstack/nuxt
bun run build:artifact                        # native host build, development evidence only
bun test test/fullstack-nuxt.test.ts          # from the repository root; needs the staged artifact
```

`build:artifact` runs `build-native.sh`, which writes to `examples/fullstack/artifacts/nuxt/native-<platform>-<arch>` (git-ignored). The Linux Arm64 path is `bash examples/fullstack/shared/build-arm64.sh examples/fullstack/nuxt -- node build-artifact.mjs`. **NOT RUN** in this session (Docker unavailable / image digest unpinned as applicable).

## Discovered Nitro node-server output (from pinned build)

- Nitro preset: `node-server` (explicit).
- Server entry: `.output/server/index.mjs` (imported by root `index.js` after endpoint env mapping).
- Hashed client asset prefix mapped to S3: `/_nuxt/` (content-hashed files under `.output/public/_nuxt/`).
- Mutable/unhashed public paths (e.g. `/robots.txt`) remain on the dynamic origin.

## Launcher contract

`index.js` parses `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`, port 1–65535), falls back to `127.0.0.1:3000` locally only, sets `HOST`, `PORT`, `NITRO_HOST`, and `NITRO_PORT`, imports `.output/server/index.mjs`, waits for the listener, then prints `READY:<port>`. `/__probe/identity` is gated by `FULLSTACK_PROBE_MARKER` and returns 404 otherwise.

## CDK composition

`stack.ts` maps only `/_nuxt/*` (from `.output/public/_nuxt/`) to a private S3 origin and routes all other traffic, including mutable/unhashed public files, to the Web Function. The stack is not deployed and synthesis never runs the framework build.

## Verification status

| Check | Status |
| --- | --- |
| Contract RED (`test/fullstack-nuxt.test.ts`, before implementation/build) | See plan Task 8 execution record. |
| Contract GREEN (`bun test test/fullstack-nuxt.test.ts`) | See plan Task 8 execution record. |
| Extracted ZIP starts on a non-default port, SSR/mutation/assets/navigation probes | See plan Task 8 execution record. |
| Linux Arm64 artifact build | **NOT RUN** (Docker unavailable). |
| Browser hydration/click navigation | **NOT RUN** (no browser runner). |
| CloudFront/AWS deployment | **NOT RUN** (not approved). |
| Streaming incremental delivery | Recorded separately only if actually verified. |

## Limits

No database, auth, persistence, image optimization, ISR/revalidation guarantees, edge runtime, WebSockets, or multi-region behavior claimed. Retained old hashed assets do not guarantee deployment-skew-safe server interactions across revisions.
