# Fullstack example shared tooling

Support code for the Next.js, Nuxt, and TanStack Start Web Function examples. It is not a framework plugin and is not part of the `WebFunction` construct. CDK synthesis never runs these builds.

## Files

- `probe.ts`: bounded child-process runner and HTTP probes. `startServer`/`withServer` spawn a launcher, wait for `READY:<port>`, verify `/__probe/identity` (marker + port), and always stop the child. `assertServerRendered`, `postJson`, `readAsset`, and `assertStreamsIncrementally` perform bounded requests (timeout and byte cap).
- `build-arm64.sh`: reproducible Linux Arm64 build in a pinned Node.js 24 container (requires running Docker).
- `build-arm64-artifacts.sh`: builds all three examples for Linux Arm64, installing pinned Bun 1.4.4 and frozen dependencies inside the container, then running each framework's `build-artifact.mjs`.
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

To build all three deployment-shaped artifacts in one step:

```sh
bash examples/fullstack/shared/build-arm64-artifacts.sh
```

### Image pin

`build-arm64.sh` uses the multi-arch index digest `node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c`, verified with `docker buildx imagetools inspect` and by running `linux/arm64` `node -p process.platform + '/' + process.arch + ' ' + process.version` (`linux/arm64 node=v24.22.1`). The build command installs Bun 1.4.4 locally in the container and uses each committed `bun.lock` with `--frozen-lockfile`; the host's darwin-native `node_modules` and build outputs are discarded in a container-local copy.

## Local verification status (Task 10, no AWS)

| Check | Status |
| --- | --- |
| Probe unit tests (`bun test test/fullstack-probe.test.ts`) | Passed locally (13 tests). |
| Next.js example tests (`bun test test/fullstack-nextjs.test.ts`) | Passed locally against native artifact (12 tests): SSR, server action validation, RSC/navigation payload, hashed static asset, public file, stack routing. |
| Nuxt example tests (`bun test test/fullstack-nuxt.test.ts`) | Passed locally against native artifact (13 tests): SSR, Nitro server mutation validation, navigation, hashed `/_nuxt` asset, mutable public file, stack routing. |
| TanStack Start example tests (`bun test test/fullstack-tanstack-start.test.ts`) | Passed locally against native artifact (14 tests): SSR, server route mutation validation, navigation, hashed `/assets` asset, mutable public file, stack routing. |
| Repo build/types | `bun run build` (JSII), `bun run test:types`, `bun run test:types:cognito` passed locally. |
| Full test suite (`bun test`) | **207 pass / 0 fail** (20 files). The previously timing-out `test/web-function.test.ts` benchmark synthesis test now has a 30s timeout. |
| Linux Arm64 container build and platform check | **PASSED locally.** All three artifacts built in a pinned `linux/arm64` Node 24.22.1 container, with native modules reported as ELF ARM aarch64 (`sharp`, `rolldown`, `lightningcss`). Artifact trees: Next 39 MB, Nuxt 3.3 MB, TanStack Start 138 MB unpacked; synthesized revision ZIPs: 12 MB / 3.3 MB / 32 MB, all under the 512 MB uncompressed limit. |
| Linux Arm64 container runtime smoke | **PASSED locally.** Each Linux Arm64 artifact started in the arm64 container on a mapped non-default host port; probe identity, SSR HTML, and native mutation (`/api/square` for Nuxt/TanStack) succeeded. |
| Browser hydration/click navigation | **NOT RUN.** No browser runner in the project; HTML probes cannot prove hydration. |
| Live AWS deployment (CloudFront, S3, Lambda, IAM/OAC, forwarding, cache behavior) | **NOT RUN / NOT APPROVED.** See `aws-checklist.md`. |

## Known open gates before claiming deployability

- Live CloudFront acceptance of the revised **1-second, Authorization-keyed** dynamic cache policy. The original all-zero-TTL policy was rejected live; cross-identity reuse remains forbidden, and same-identity reuse for ≤1 second is approved. The operator also accepted (`ACCEPT`) that same-Authorization cookie/query variants may share that 1-second entry; cookie/query cache isolation is not claimed.
- Real Lambda acceptance of the resource policy shape (function ARN as `ResourceArn`, endpoint ARN in statement `Resource`, distribution-scoped `aws:SourceArn`).
- Correct static `Content-Type` from implicit `aws s3 sync` MIME inference.
- End-to-end forwarding/origin behavior (`Host`, `X-Forwarded-*`, server-action/redirect origin checks) behind CloudFront.
- Deployment-skew-safe behavior for old assets vs new server actions/revisions is not guaranteed by current design; no ISR/image optimization/edge/WebSockets/multi-region claims.
