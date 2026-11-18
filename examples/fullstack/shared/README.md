# Fullstack example shared tooling

Support code for the Next.js, Nuxt, and TanStack Start Web Function examples. It is not a framework plugin and is not part of the `WebFunction` construct. CDK synthesis never runs these builds.

## Files

- `probe.ts`: a bounded child-process runner and HTTP probes. `startServer`/`withServer` spawn a launcher, wait for its readiness line, verify its identity, and always stop it. `inspectPage`, `postJson`, `readAsset`, and `assertStreamsIncrementally` run bounded requests (timeout and byte cap) against it.
- `build-arm64.sh`: the reproducible Linux Arm64 build, run in a pinned Node.js 24 container.
- `build-native.sh`: a host build for rapid iteration. Its output is development evidence only.

Tests: `test/fullstack-probe.test.ts`.

## Launcher contract for probes

A framework launcher under test must:

1. Listen on the `host:port` in `AWS_LAMBDA_HTTP_ENDPOINT`. Port `0` means the launcher chooses the port.
2. Print `READY:<port>` on stdout after binding.
3. Answer `GET /__probe/identity` with JSON `{"marker": <FULLSTACK_PROBE_MARKER>, "port": <bound port>}`.

The probe sets `FULLSTACK_PROBE_MARKER` to a new random value for each start. A different server on the same port fails the identity check. Only the framework launcher should serve `/__probe/identity`, and only in the smoke-test configuration. Task 7 must decide whether a deployed artifact keeps this route.

## Build commands

Docker is a build tool, not the Web Function runtime. The arm64 script refuses to run unless the Docker daemon is reachable. It never falls back to a native build.

```sh
# Linux Arm64 artifact (requires a running Docker daemon and a pinned image digest)
bash examples/fullstack/shared/build-arm64.sh examples/fullstack/<framework> -- <build command>

# Native host build for iteration (requires Node.js 24; not deployment evidence)
bash examples/fullstack/shared/build-native.sh examples/fullstack/<framework> -- <build command>
```

The build command runs in the workspace. It must write its deployable tree to `$ARTIFACT_OUT`. Artifacts go to `examples/fullstack/artifacts/<framework>/linux-arm64` or `.../native-<platform>-<arch>`. The `artifacts/` folder is git-ignored.

### Image pin (open)

`build-arm64.sh` uses `node:24.22.1-bookworm-slim`, which matches the mise-pinned Node version. Its digest is a `TODO` placeholder, because a digest could not be verified offline and none was invented. The script refuses to run until the verified `sha256` digest is set.

## Verification status

| Check | Status |
| --- | --- |
| Probe unit tests (`bun test test/fullstack-probe.test.ts`) | Passed locally |
| Native script control flow (failure paths, non-empty output) | Exercised locally |
| Arm64 script control flow with a fake `docker` | Exercised locally; a logic check only |
| Linux Arm64 container build and `node -p process.platform+'/'+process.arch` in the container | **NOT RUN.** The Docker daemon was unavailable, and the image digest is unpinned. |
| Browser hydration, navigation, and the framework mutation | **Not implemented.** No browser runner is in the project. Playwright or Puppeteer would need a reproducible install first. |

HTML probes cannot prove hydration. Browser smoke tests are the follow-up for Tasks 7–9.
