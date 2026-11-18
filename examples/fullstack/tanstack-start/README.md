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

Server-side behavior is implemented with TanStack Start route `server.handlers` (native server routes), including a validating mutation at `/api/square` and a probe-only identity route at `/__probe/identity` (returns 404 unless `FULLSTACK_PROBE_MARKER` is set).

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

The test synthesizes the stack, extracts the Lambda ZIP, resolves literal runtime `require()` paths, and runs the extracted artifact through `examples/fullstack/shared/probe.ts` on a non-default port. It verifies SSR HTML, native server mutation validation, navigation reachability, hashed client asset serving, and mutable public file serving.

## CDK routing

`stack.ts` composes `WebFunction` (IAM-protected) with `WebFunctionDelivery`:

- `/_next/static/*` equivalent for this app is `/assets/*` → S3 origin from `dist/client/assets` (immutable).
- All other paths → Web Function (dynamic).

## Limitations and unverified behavior

- **Linux Arm64 artifact proof is local only.** The artifact was built in a pinned `linux/arm64` Node 24.22.1 container (Bun 1.4.4, frozen lockfile), with ARM aarch64 native modules, and started there serving SSR and `/api/square`; **AWS deployment is not run**.
- **No browser hydration/click proof in this task.** HTTP and RSC-like navigation checks only; full browser interaction not verified.
- **Streaming:** the server uses `defaultStreamHandler`; incremental streaming delivery to CloudFront/Lambda was not separately measured.
- Does not demonstrate ISR/cache consistency, deployment-skew-safe old server actions, image optimization, edge runtime, WebSockets, or multi-region behavior.
- Live CloudFront acceptance of the revised 1-second Authorization-keyed dynamic policy and the Lambda resource-policy shape remain deployment-gated (the original zero-TTL policy was rejected live). See `docs/superpowers/plans/2026-11-18-fullstack-preflight.md` and the plan’s live-AWS gate.
