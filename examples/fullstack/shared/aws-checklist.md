# Fullstack AWS deployment checklist (gated)

**Status: GATED — first single-stack probe failed at the CloudFront cache-policy preflight; no full live run.** A bounded `FullstackNextjs` deploy was authorized and executed under profile `jolo` in `eu-central-1` (account `246350246460`). CloudFront rejected the all-zero-TTL cache policy with `Authorization` in the cache key: `The parameter HeaderBehavior is invalid for policy with caching disabled`. The stack rolled back and was destroyed. Three CDK bootstrap asset objects uploaded before the failure (12.6 MB revision ZIP, 184 KB static ZIP, 32 KB template JSON, all `2026-11-18T19:15:59Z`) were explicitly deleted and verified gone; no stack, bucket, distribution, or uploaded asset remains. Per the approved design, work stopped for a design revision. The operator explicitly approved the `TTL1` revision (1-second TTL with `Authorization` still the only cache-key header, preserving cross-identity isolation) on 2026-11-18; the single Next.js stack may be re-probed with the same bounded limits. Do not deploy Nuxt/TanStack until the revised policy is accepted, and do not further weaken the policy without another decision.

## Scope

Validate the three example stacks (Next.js, Nuxt, TanStack Start) composed as `WebFunction` + `WebFunctionDelivery` with Linux Arm64, Node.js 24-compatible artifacts:

- Immutable hashed static assets served from private S3 via CloudFront (OAC).
- Dynamic traffic served by IAM-protected Web Functions (Lambda OAC, `lambda:InvokeWebFunctionEndpoint`).
- No shared dynamic caching; dynamic cache policy keyed by `Authorization` with zero TTLs (must be accepted by live CloudFront).
- Lambda resource policy shape as synthesized (function ARN in `ResourceArn`, endpoint ARN in statement `Resource`, `aws:SourceArn` scoped to distribution) must be accepted by real Lambda.

## Pre-deployment gates (must be satisfied before claiming deployability)

- [ ] **Explicit approval obtained** with: AWS account (read-only `sts get-caller-identity` under profile `jolo` resolved `246350246460`, `arn:aws:iam::246350246460:user/jolo`), region `eu-central-1` (operator-supplied), stack names (one per framework), exact `cdk deploy`/destroy commands, expected resources, cost drivers, spending/traffic caps, request schedule, required checks, and cleanup/verification commands. **Profile and region alone are not the full approval.**
- [x] **Linux Arm64 artifacts built and verified locally** in a pinned `node:24.22.1-bookworm-slim` (verified multi-arch digest) `linux/arm64` container via `examples/fullstack/shared/build-arm64-artifacts.sh`: Node `v24.22.1`, ARM aarch64 native modules, artifact/ZIP sizes and synthesis checked, and container runtime smoke (identity, SSR, mutation) passed. This is local container evidence only; it does not replace live AWS verification.
- [x] **CloudFront policy preflight — FAILED (stop condition).** The all-zero-TTL + Authorization cache policy is rejected by CloudFront (`HeaderBehavior is invalid for policy with caching disabled`). Per design, no Nuxt/TanStack rollout and no policy weakening without a new operator decision. See `docs/superpowers/plans/2026-11-18-fullstack-preflight.md`, "Live gate result".

## Bounded live probes (after approval and deploy)

Run with bounded request counts and record real HTTP responses/timings. Allow bounded propagation/retry delays for CloudFront distribution deployment; do not treat propagation delay as success.

### Per-framework functional checks
- [ ] **SSR:** first HTML response contains request-time server-rendered content (no JavaScript required).
- [ ] **Navigation:** secondary route/page is reachable.
- [ ] **Native server mutation:** valid input returns computed result; invalid input is rejected server-side.
- [ ] **Static assets:** hashed client assets load via CloudFront from S3 with immutable caching behavior; content/type correct (verify MIME types from S3 sync inference).
- [ ] **Mutable public file:** served from dynamic origin path as intended.
- [ ] **Streaming (if supported):** record first-byte and intermediate-chunk timing to confirm incremental delivery through CloudFront/Web Function; record as not supported/not observed if not.

### Security, forwarding, and cache-correctness checks
- [ ] **Unsigned direct origin access:** direct unsigned requests to the Web Function endpoint are rejected (403) when IAM auth/OAC policy is in effect.
- [ ] **Authorization isolation:** distinct `Authorization` values produce distinct dynamic responses (GET and POST) with no cross-user cache bleed.
- [ ] **Cookies/query/errors:** dynamic responses with cookies/query parameters and error responses are not served from a shared cache entry across different requests/users.
- [ ] **Host/proxy correctness:** `Host` and forwarding behavior are correct; host-spoof and redirect/mutation origin probes do not allow spoofed origin behavior. The viewer-request function sets `x-public-host` (CloudFront forbids `x-forwarded-host`); verify that frameworks ignore client-supplied `x-forwarded-host` and that redirects/server actions do not rely on an unconsumed public-host header.
- [ ] **Static old-URL retention after update:** deploy a second build/update, then request an old hashed asset URL using a unique query string or a path not previously fetched (to avoid edge-cache masking) and verify the prior key remains accessible through CloudFront/S3 (prune disabled). Distinguish S3 retention from edge cache hits.

### Headers/forwarding notes to verify live
- Confirm whether client-controlled `x-forwarded-port`, `x-real-ip`, and `via` pass through (origin request policy forwards all viewer headers except Host) and whether Lambda endpoint appends an `X-Forwarded-For` hop beyond CloudFront; document observed behavior before claiming forwarding correctness.

## Cleanup (approved stacks only)

- [ ] Destroy each approved stack with the exact approved destroy command(s).
- [ ] Wait for CloudFront distribution and stack deletion to complete.
- [ ] Verify deletion: stacks no longer exist; no unintended retained buckets/distributions/endpoints remain except resources explicitly configured with `RETAIN` (asset buckets default to `RETAIN` unless removal policy was set to `DESTROY` in the example). Record retained resources and their identifiers.
- [ ] Confirm no ongoing billable resources remain for the test.

## Reporting requirements

Capture and report, per framework:
- Local proof, arm64 build proof, and live AWS proof **separately** (do not conflate).
- Exact artifact identifiers/paths, stack names, region, distribution/domain URLs used, request samples, status codes, headers (cache/content-type), and mutation results.
- Any deviations, propagation retries, or real failures (report honestly; do not mask).
- Cleanup evidence.
