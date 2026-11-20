# Astro (SSR, `@astrojs/node` mode "local") on a Lambda Web Function

An Astro 5 app running server-side rendering on a Lambda Web Function. It demonstrates request-time SSR, a validated JSON mutation endpoint, and static public files, with content-hashed client assets served from private S3 behind CloudFront. It is the stateless counterpart of the TanStack Start example: no session password or auth wiring of any kind, no database, no login, no persistence.

Status: **local proof only.** The native `build:artifact` output is development evidence; the shared Linux Arm64 artifact path used by `cdk-app.ts` is not built in this change, and the stack is not deployed.

## Pinned versions

| Package | Version | Note |
| --- | --- | --- |
| `astro` | `^5` (5.18.2 in `bun.lock`) | `output: "server"` SSR build. |
| `@astrojs/node` | `^9` (9.5.5 in `bun.lock`) | `mode: "local"` — exports a request handler instead of binding a listener. |
| `@types/node` | `^24` | Dev tooling for the `tsconfig.json` gate. |

`bun.lock` pins the full graph. Install with `bun install --frozen-lockfile`.

## Files

- `src/pages/index.astro`: request-time SSR home page (`<p id="ssr-time">Rendered on the server at {timestamp}</p>`) with a nav link to `/about`.
- `src/pages/about.astro`: short static copy page.
- `src/pages/api/square.ts`: POST mutation with server-side validation (integer 0–1000 → 400 with `Value must be a number from 0 to 1000`), returns `{ result: n * n }`.
- `public/robots.txt`: mutable static public file, staged to `dist/client` root.
- `astro.config.mjs`: `output: "server"`, `adapter: node({ mode: "local" })`.
- `index.js`: root launcher (see the launcher contract below).
- `build-artifact.mjs`: runs `astro build` and stages `dist/client`, `dist/server`, `index.js`, `package.json`, and the runtime `node_modules` subtree.
- `stack.ts`: thin CDK composition using `AstroWebFunction` (Web Function + `WebFunctionDelivery` mapping `/_astro/` to S3).
- `tsconfig.json`: type-check gate (`astro/tsconfigs/strict` + `types: ["node"]`), includes the launcher, staging script, and stack.

## Build and test

```sh
bun install --frozen-lockfile                 # in examples/fullstack/astro
bun run build:artifact                        # native host build, development evidence only
bun test test/fullstack-astro.test.ts         # from the repository root; needs the staged artifact
```

`build:artifact` runs `build-native.sh`, which writes to `examples/fullstack/artifacts/astro/native-<platform>-<arch>` (git-ignored). The Linux Arm64 path is `bash examples/fullstack/shared/build-arm64-artifacts.sh`.

## Launcher contract

`index.js` parses `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`, port 0 allowed; unparseable/empty values are refused before anything starts), imports `dist/server/entry.mjs`, and hosts the adapter's exported `handler` on the launcher's own `node:http` server, then prints `READY:<bound port>`. `/_astro/*` statics (content-hashed, from `dist/client/_astro/`) are served directly by the launcher with `public, max-age=31536000, immutable` and a correct content type; other `dist/client` files (e.g. `/robots.txt`) are also served by the launcher. `/__probe/identity` is gated by `FULLSTACK_PROBE_MARKER` and returns 404 otherwise. A bound port fails to start with `EADDRINUSE`, matching the other launchers.

Unlike the TanStack launcher (which hosts the app's fetch handler through `srvx/node`), this launcher wires a Node-style `(req, res)` handler to `node:http` directly. Unlike the TanStack example, no session secret is configured anywhere — this app has no auth.

## CDK composition

`stack.ts` (`AstroExampleStack`) maps only `/_astro/*` (from `dist/client/_astro/`) to a private S3 origin and routes all other traffic, including mutable/unhashed public files, to the Web Function. Synthesis never runs the framework build.

Note: `cdk-app.ts` wires `FullstackAstro` against the native `native-darwin-arm64` artifact; the shared `artifact()` helper resolves `linux-arm64`, which is not built in this change. A Linux Arm64 artifact must be staged with `build-arm64-artifacts.sh` before synthesizing a real deployment.

## Limits

No database, auth, persistence, client-side scripts, image optimization, edge runtime, WebSockets, or multi-region behavior claimed. No live deployment exists.
