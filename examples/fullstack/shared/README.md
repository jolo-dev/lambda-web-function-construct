# Fullstack example shared tooling

Support code for the Next.js, Nuxt, and TanStack Start Web Function examples. It is not a framework plugin and is not part of the `WebFunction` construct. CDK synthesis never runs these builds.

## Files

- `probe.ts`: bounded child-process runner and HTTP probes. `startServer`/`withServer` spawn a launcher, wait for `READY:<port>`, verify `/__probe/identity` (marker + port), and always stop the child. `assertServerRendered`, `postJson`, `readAsset`, and `assertStreamsIncrementally` perform bounded requests (timeout and byte cap).
- `build-arm64.sh`: reproducible Linux Arm64 build in a pinned Node.js 24 container (requires running Docker and a verified image digest).
- `build-native.sh`: host build for rapid iteration. Output is development evidence only, not deployment evidence.
- `aws-checklist.md`: **gated** live-AWS deployment/cleanup checklist (**NOT APPROVED / NOT RUN**).

Tests: `test/fullstack-probe.test.ts`.

## Launcher contract for probes

A framework launcher under test must:

1. Listen on the `host:port` in `AWS_LAMBDA_HTTP_ENDPOINT`. Port `0` means the launcher chooses an ephemeral port and reports it.
2. Print `READY:<port>` on stdout after binding.
3. Answer `GET /__probe/identity` with JSON containing at least `{"marker": <FULLSTACK_PROBE_MARKER>, "port": <bound port>}` while the marker env var is set.

The probe sets `FULLSTACK_PROBE_MARKER` to a new random value per start. Only the smoke-test launcher should serve `/__probe/identity`; Next/Nuxt gate it in framework routes, TanStack Start gates it in the launcher.

## Build commands

Docker is a build tool, not the Web Function runtime. `build-arm64.sh` refuses to run without a reachable Docker daemon and never falls back to a native build.

```sh
# Linux Arm64 artifact (requires running Docker daemon and a pinned image digest)
bash examples/fullstack/shared/build-arm64.sh examples/fullstack/<framework> -- <build command>

# Native host build for iteration (requires Node.js 24; not deployment evidence)
bash examples/fullstack/shared/build-native.sh examples/fullstack/<framework> -- <build command>
```

The build command runs in the workspace and must write its deployable tree to `$ARTIFACT_OUT`. Artifacts go to `examples/fullstack/artifacts/<framework>/linux-arm64` or `.../native-<platform>-<arch>`. `artifacts/` is git-ignored.

### Image pin (open)

`build-arm64.sh` uses `node:24.22.1-bookworm-slim`, matching the mise-pinned Node version. Its digest is a `TODO` placeholder because a digest could not be verified offline; the script refuses to run until a verified `sha256` digest is set.

## Local verification status (Task 10, no AWS)

| Check | Status |
| --- | --- |
| Probe unit tests (`bun test test/fullstack-probe.test.ts`) | Passed locally (13 tests). |
| Next.js example tests (`bun test test/fullstack-nextjs.test.ts`) | Passed locally against native artifact (12 tests): SSR, server action validation, RSC/navigation payload, hashed static asset, public file, stack routing. |
| Nuxt example tests (`bun test test/fullstack-nuxt.test.ts`) | Passed locally against native artifact (13 tests): SSR, Nitro server mutation validation, navigation, hashed `/_nuxt` asset, mutable public file, stack routing. |
| TanStack Start example tests (`bun test test/fullstack-tanstack-start.test.ts`) | Passed locally against native artifact (14 tests): SSR, server route mutation validation, navigation, hashed `/assets` asset, mutable public file, stack routing. |
| Repo build/types | `bun run build` (JSII), `bun run test:types`, `bun run test:types:cognito` passed locally. |
| Full test suite (`bun test`) | 206 pass / 1 fail: **pre-existing unrelated** timeout in `test/web-function.test.ts` (`synthesizes all six benchmark example stacks cleanly`, exceeds 5s default), not caused by fullstack example changes. |
| Linux Arm64 container builds (`node -p process.platform+'/'+process.arch` in container) | **NOT RUN.** Docker daemon unavailable; image digest unpinned. Native artifacts are not deployment evidence. |
| Browser hydration/click navigation | **NOT RUN.** No browser runner in the project; HTML probes cannot prove hydration. |
| Live AWS deployment (CloudFront, S3, Lambda, IAM/OAC, forwarding, cache behavior) | **NOT RUN / NOT APPROVED.** See `aws-checklist.md`. |

## Known open gates before claiming deployability

- Live CloudFront acceptance of the all-zero-TTL dynamic cache policy keyed by `Authorization`.
- Real Lambda acceptance of the resource policy shape (function ARN as `ResourceArn`, endpoint ARN in statement `Resource`, distribution-scoped `aws:SourceArn`).
- Correct static `Content-Type` from implicit `aws s3 sync` MIME inference.
- End-to-end forwarding/origin behavior (`Host`, `X-Forwarded-*`, server-action/redirect origin checks) behind CloudFront.
- Deployment-skew-safe behavior for old assets vs new server actions/revisions is not guaranteed by current design; no ISR/image optimization/edge/WebSockets/multi-region claims.
