# Fullstack AWS deployment checklist (gated)

**Status: NOT APPROVED / NOT RUN.** This checklist is for a future, explicitly approved live deployment only. Design approval and plan approval do **not** authorize any AWS action. Do not run these commands without fresh operator approval that states account, region, stack names, exact deploy commands, expected resources, cost drivers/limits, bounded traffic caps, and cleanup expectations.

## Scope

Validate the three example stacks (Next.js, Nuxt, TanStack Start) composed as `WebFunction` + `WebFunctionDelivery` with Linux Arm64, Node.js 24-compatible artifacts:

- Immutable hashed static assets served from private S3 via CloudFront (OAC).
- Dynamic traffic served by IAM-protected Web Functions (Lambda OAC, `lambda:InvokeWebFunctionEndpoint`).
- No shared dynamic caching; dynamic cache policy keyed by `Authorization` with zero TTLs (must be accepted by live CloudFront).
- Lambda resource policy shape as synthesized (function ARN in `ResourceArn`, endpoint ARN in statement `Resource`, `aws:SourceArn` scoped to distribution) must be accepted by real Lambda.

## Pre-deployment gates (must be satisfied before claiming deployability)

- [ ] **Explicit approval obtained** with: AWS account, region, stack names (one per framework), exact `cdk deploy`/destroy commands, expected resources (CloudFront distributions, S3 buckets, Lambda Web Functions/endpoints/revisions, policies, deployments), cost drivers (CloudFront requests/data transfer, S3 storage/requests, Lambda invocations/duration, asset deployment custom resources), spending/traffic caps, request schedule, required checks, and cleanup/verification commands.
- [ ] **Linux Arm64 artifacts built and verified** in a pinned `node:24.x` container (`examples/fullstack/shared/build-arm64.sh`) with verified image digest, correct ZIP structure/size, Node 24 inside container, and correct architecture for any native modules. (Currently **NOT RUN**: Docker unavailable, image digest unpinned.)
- [ ] **CloudFront policy preflight:** probe that CloudFront accepts the all-zero-TTL cache policy with `Authorization` in the cache key for the dynamic behavior. If rejected, **stop and seek design revision** before rolling out stacks.

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
- [ ] **Host/proxy correctness:** `Host` and forwarding behavior are correct; host-spoof and redirect/mutation origin probes do not allow spoofed origin behavior. Verify `x-forwarded-host`/origin handling for framework server actions/redirects.
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
