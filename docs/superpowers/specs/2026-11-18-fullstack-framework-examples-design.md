# Fullstack framework examples on Lambda Web Functions

Date: 2026-11-18
Status: Approved by operator after independent spec review; implementation pending.

## Goal

Demonstrate that Next.js, TanStack Start, and Nuxt production Node servers can run on Lambda Web Functions. Extend the construct to preserve prebuilt production output, add optional static delivery, and verify actual fullstack behavior rather than merely synthesizing resources.

This is production-server compatibility, not feature parity with a managed framework hosting platform. Framework-specific build knowledge stays in the examples; it does not enter the core construct.

## Approved decisions

- Deliver all three examples sequentially, with pinned and recorded framework versions.
- Preserve the existing bundled `entry` mode and add an exclusive prebuilt-directory mode.
- Build frameworks explicitly before CDK synthesis; do not run framework builds in constructors.
- Keep CloudFront and browser-asset storage in a separate optional construct.
- Use CloudFront with private S3 for explicit immutable asset paths and an IAM-protected Web Function Endpoint for dynamic traffic.
- Disable cross-identity shared caching for dynamic traffic; preserve request data needed by framework rendering and mutations. **Operator-approved revision (2026-11-18):** a 1-second, Authorization-keyed micro-cache replaces the originally planned all-zero TTL after CloudFront rejected that policy live. See the routing section below.
- Retain previous hashed assets across updates. Disposable examples remove assets on stack destruction.
- Use single-region examples and CloudFront-provided domains initially.
- Provide explicit Linux Arm64 production builds. Native local builds are development conveniences, not deployment evidence.
- Keep examples stateless, with SSR, hydration/navigation, a native server-side mutation, assets, and streaming where supported.
- Require build, packaging, synthesis, local production-server, and live AWS verification. Live deployment requires separate operator approval.

## Current implementation and evidence

`src/web-function.ts` currently requires one `entry`, runs `bun build --target=node`, and archives only `index.js`. Production framework directories, dependency trees, chunks, manifests, and assets cannot survive that interface. The current private S3 bucket stores revision ZIP files; it is not a browser-asset origin.

Existing examples explicitly listen on `AWS_LAMBDA_HTTP_ENDPOINT`. Current tests primarily establish synthesis and do not establish production framework readiness. The h3 example is not proof of Nuxt compatibility.

Official AWS documentation establishes:

- The supported runtime is Node.js 24 on Linux Arm64.
- ZIP packages must contain runtime dependencies and stay within the 512 MB uncompressed limit.
- The default startup file is root `index.js`; `AWS_LAMBDA_NODEJS_ENTRYPOINT` selects another package-relative file. `package.json` startup scripts are not invoked automatically.
- Servers must bind to the supplied `AWS_LAMBDA_HTTP_ENDPOINT` and begin listening within 10 seconds.
- A user-managed CloudFront distribution can use a Web Function Endpoint as an HTTPS origin with Web-Function-specific OAC.
- Regional origins use `sigv4`, `always-amz-auth`, and origin type `lambda`. This is not the ordinary Function URL signing contract.
- CloudFront invocation requires `lambda:InvokeWebFunctionEndpoint`, a policy attached to the Web Function, an endpoint-scoped resource, and a distribution-scoped `aws:SourceArn` condition.
- The viewer's `Host` must not be sent as the origin `Host`.

The installed CDK exposes `ALWAYS_AMZ_AUTH`, `SIGV4A`, and `CfnResourcePolicy`. No custom resource is needed merely to express these settings. Only regional delivery is in initial scope.

## Module design

### 1. WebFunction: deploy a server artifact

Extend `WebFunctionProps` with this interface:

| Property | Meaning |
| --- | --- |
| `entry?: string` | Existing bundled TS/JS entry mode; behavior remains unchanged. |
| `artifact?: WebFunctionArtifactOptions` | Prebuilt production directory mode. |
| `artifact.directory: string` | Root of a self-contained deployment tree. |
| `artifact.entrypoint: string` | JavaScript startup file relative to that root. |

Exactly one of `entry` and `artifact` is required. Use JSII-compatible interfaces rather than a public TypeScript discriminated union. Runtime validation rejects both/neither, missing files, absolute entrypoints, traversal outside the root, and non-file entrypoints.

Artifact mode does not rebundle, install dependencies, invoke a shell startup command, or infer framework layouts. Preserve package metadata, ESM/CJS semantics, file-relative imports, required files, and permissions. Stage the supplied root into private temporary storage and ZIP the complete staged tree. Do not modify the caller's directory.

Resolve internal symlinks into their packaged content; reject broken links, cycles, and links escaping the artifact root. Count staged bytes after resolution against the uncompressed size limit. Do not include unrelated project files by implicitly choosing a parent directory.

Set `AWS_LAMBDA_NODEJS_ENTRYPOINT` from the artifact entrypoint. Reject conflicting caller values; do not permit caller configuration to override platform-owned `AWS_LAMBDA_HTTP_ENDPOINT`. Existing environment-variable behavior otherwise remains intact. The construct does not claim to prove native-module ABI compatibility by inspecting filenames: the Linux Arm64 build and runtime tests supply that evidence.

Temporary directories and archives are owned by the packaging operation and removed on failure, with the existing process-exit cleanup retained as a final safeguard. Repeated packaging of unchanged staged content must not cause avoidable revision churn through random archive paths or volatile metadata.

Keep the current code-bucket, immutable Revision, and Endpoint model. Do not refactor unrelated Cognito or benchmark behavior.

Expose the endpoint ARN, auth mode, and endpoint type as read-only properties alongside the existing function ARN, endpoint domain, and revision ID. These let the delivery module validate its prerequisites without reading private implementation fields.

### 2. WebFunctionDelivery: optional browser delivery

Add an exported `WebFunctionDelivery` construct in `src/web-function-delivery.ts`. It accepts an existing `WebFunction` and explicit immutable static-asset mappings. The initial interface supports only a same-stack `HomeRegion` Web Function using `IamAuth`; reject incompatible configurations rather than silently weakening origin protection.

Each static mapping contains:

- `directory`: the built asset directory.
- `urlPrefix`: a normalized absolute directory prefix, such as `/_next/static/`.

Upload files beneath the corresponding S3 key prefix, without rewriting the framework's URLs. A mapping is a caller declaration that its files are public and content-addressed/immutable. Reject missing directories, root-prefix mappings, traversal, wildcard-containing prefixes, and overlapping mappings. Do not infer CDN routing from filename extensions or route every `public/` file to immutable storage.

The module owns:

- A separate private, SSL-only asset bucket with public access blocked.
- S3 OAC restricted to the distribution.
- A CloudFront distribution using the generated domain and HTTPS viewers.
- An HTTPS Web Function origin, regional Web Function OAC, and its invocation resource policy.
- Explicit static behaviors and a default dynamic behavior.
- A controlled proxy-context transformation and security response headers.

Expose the distribution, asset bucket, and public HTTPS URL for inspection and integration. Support an explicit removal policy: retain the asset bucket by default; disposable examples opt into destruction and object cleanup. Do not attach CloudFront or asset buckets to existing backend-only callers.

One delivery construct owns the Web Function resource policy in this initial interface. Reject a second delivery attachment. Do not create competing policy resources or mix this policy with `AWS::Lambda::Permission`. Document policy ownership so callers do not independently replace the same function policy.

### Routing and request handling

| Traffic | Origin | Caching |
| --- | --- | --- |
| Explicit immutable asset prefixes | Private S3 | Public, long-lived immutable caching, GET/HEAD only. |
| SSR, framework data, mutations, APIs, arbitrary public files | Web Function | Authorization-keyed 1-second micro-cache (no cross-identity reuse); all supported HTTP methods. Originally specified as zero TTL, revised after live CloudFront rejection. |

Do not add SPA error rewrites or turn missing static objects into successful HTML. Keep framework-specific dynamic paths, including image-processing paths, on the server; their presence does not imply supported image optimization.

Forward required cookies, query strings, framework headers, and viewer authorization. Exclude viewer `Host` from the origin request and use the endpoint hostname. A viewer-request CloudFront Function overwrites `X-Forwarded-Host` from the actual viewer host and `X-Forwarded-Proto` with the enforced HTTPS scheme; never trust client-supplied copies. Framework launchers/configuration must consume this controlled public-origin context where needed, particularly for redirects and mutation origin checks.

The authorization-forwarding configuration needs a deliberate compatibility check: the Web Function OAC guide specifically requires `Authorization` in the cache policy for relevant GET/HEAD behaviors, whereas the managed `CachingDisabled` policy has no cache-key headers. Do not assume an origin request policy alone satisfies that guide, or silently enable caching to work around policy validation. Live probes must exercise GET and POST authorization.

**Live gate and operator-approved revision (2026-11-18):** CloudFront rejected the originally planned policy (`MinTTL = DefaultTTL = MaxTTL = 0` plus `Authorization` in the cache key) with `HeaderBehavior is invalid for policy with caching disabled`. Per this spec the work stopped for a design decision. The operator approved a 1-second minimum/default/maximum TTL while retaining `Authorization` as the only cache-key header. This preserves per-viewer isolation (no cross-identity reuse) while permitting a same-identity response to be reused for at most one second; the previous “no shared caching at all” wording is superseded. Do not switch to managed `CachingDisabled`, and do not increase the TTL without a new decision.

Use a framework-compatible security response-headers policy for HSTS, content-type sniffing prevention, and framing protection. Do not impose a guessed CSP that breaks framework inline scripts. Document application-specific CSP and WAF as production hardening outside this proof.

### Origin protection

Use Web Function `IamAuth`, OAC signing behavior `always-amz-auth`, and regional `sigv4`. Attach a single `CfnResourcePolicy` to the Web Function, granting CloudFront `lambda:InvokeWebFunctionEndpoint` only for the selected endpoint and distribution. End users do not need AWS credentials when using CloudFront.

The endpoint remains network-public. Unsigned direct invocation must fail. Do not describe it as private networking or claim other explicitly authorized IAM principals cannot invoke it directly. Existing Cognito provisioning requires `ApplicationManaged` and is not combined with this IAM-origin example design.

### Deployment and retention

Upload immutable assets before making a new Revision reachable. Express dependencies without a distribution/revision/policy cycle: asset upload must not depend on distribution invalidation. Do not prune previous objects on update or run broad invalidations for immutable filenames. Add a two-build test proving old asset URLs remain usable.

Retention protects old chunks; it does not guarantee that old browser clients can invoke server actions from a previous framework build after the server revision changes. Document that distinction and do not promise managed-platform deployment-skew protection.

S3 objects, CloudFront rollout, and resource-policy propagation can have different readiness times. Verification waits for deployment completion and uses bounded retries for propagation before classifying failures. Cleanup deletes only the expressly approved example stacks; no account-wide cleanup.

## Framework examples

Place the examples under `examples/fullstack/nextjs/`, `examples/fullstack/tanstack-start/`, and `examples/fullstack/nuxt/`, with shared deployment/probe support under `examples/fullstack/shared/`.

Each example owns its package manifest and lockfile, pinned compatible versions, explicit build commands, launcher, staging logic, CDK composition, and README. Keep existing minimal server and benchmark examples intact. Do not introduce a general-purpose framework adapter plugin system.

Build sequentially in this order:

1. Next.js standalone: preserve the standalone server, traced dependencies/manifests, needed `public` files, and `.next/static` layout. Offload the explicit `/_next/static/` tree.
2. Nuxt/Nitro Node-server preset: preserve the complete `.output` runtime layout; offload its explicit hashed asset tree, not all public files.
3. TanStack Start: pin and inspect the actual supported production Node-server build. Determine its listener and client asset output from that version; do not assume an entry filename or treat a fetch-handler export as a listening server.

A small JavaScript launcher maps `AWS_LAMBDA_HTTP_ENDPOINT` to each server's supported startup conventions before importing the production entry. It preserves generated module semantics and does not launch a development server. Port fallback is local-only. A wrong port or failed import must surface as a startup failure.

Provide a reference Linux Arm64 Node.js 24 container build path. The container produces ZIP inputs, not a deployed container image. The examples document Docker prerequisites, dependency installation, artifact output locations, and a separate native development path. Builds never execute implicitly during synthesis. Framework prerequisites or dependency versions discovered during planning must not silently broaden the promised feature set.

Use equivalent small demonstrations, not identical framework internals:

- Request-specific SSR content visible in the initial HTML without client JavaScript.
- A client interaction and client-side navigation proving hydration and chunk loading.
- A native server-side mutation that validates a small input and returns a computed result.
- A hashed static asset served through S3/CloudFront.
- A streaming response or framework rendering demonstration where supported, with observed incremental delivery recorded.

No database, login flow, global mutable application state, distributed cache, or in-memory persistence claim. Image optimization, ISR/revalidation consistency, tag invalidation, Nuxt SWR persistence, edge runtimes, WebSockets, and multi-region consistency are not acceptance claims. Record unsupported or unverified capabilities explicitly.

## Verification and acceptance

### Construct and archive tests

- Existing bundled-entry callers still compile, synthesize, and pass existing tests.
- Artifact mode validates exclusivity, containment, symlinks, entrypoint existence, size, and environment conflicts.
- Inspect extracted ZIP fixtures containing nested imports, ESM/CJS metadata, runtime dependencies, and assets. Start the extracted artifact, not the source directory.
- Exercise failed packaging and verify temporary artifact cleanup.
- Verify stable artifact identity for unchanged content and changed identity for changed runtime files.
- Run package JSII build, existing tests, and relevant type checks; test the new exported interface.

### Delivery synthesis tests

Assert origin isolation, OAC signing values, scoped resource policies, single ownership, HTTPS, method settings, forwarding/cache semantics, proxy-context overwrite, asset-prefix mapping, retention, and dependency ordering. Assert existing WebFunction-only stacks create no browser-delivery resources. Reject incompatible auth/endpoint types and ambiguous asset mappings.

### Local production tests

For each framework, build a pinned production artifact, extract the deployable ZIP, and start it with an explicitly supplied platform endpoint on a non-default test port. Verify initial HTML SSR, assets, the native mutation, redirects/cookies where used, and startup errors. Browser tests verify hydration and navigation; HTML requests alone cannot prove hydration. Distinguish native development evidence from Linux Arm64 evidence.

### Live AWS gate

Before deployment, present the account, region, stack names, resource types, expected cost drivers, capacity/throttle limits, and cleanup commands for approval. Approval of this design is not approval to deploy. Use bounded test load, not benchmarks.

For each deployed example verify:

- CloudFront HTTPS serves request-time SSR and correct public-origin redirects.
- Browser hydration, navigation, and the framework-native mutation work through CloudFront.
- GET and POST preserve viewer authorization; cookies and query strings reach dynamic code correctly.
- Distinct dynamic requests with different Authorization values are not served from a shared cache entry; the 1-second Authorization-keyed micro-cache may reuse a response only for the same identity. Verify this explicitly with distinct Authorization GET/POST probes.
- A static object is served successfully, produces a subsequent cache hit, has correct content type/cache headers, and remains inaccessible directly from S3.
- Unsigned direct Web Function access is rejected; CloudFront-signed origin access succeeds.
- Assets from a previous build remain available after an update.
- Streaming delivers incremental chunks when claimed; test time-to-first-chunk and inter-chunk arrival rather than only final response contents.
- Logs and actual HTTP requests establish readiness, including a fresh Revision request; resource status alone is insufficient.

Record versions, artifact/build platform, commands, tested capabilities, failures, and cleanup outcome. Do not label the work fully proven if live verification is not approved or any required capability remains unverified.

## Failure handling and implementation discipline

Fail synthesis for invalid local inputs instead of deploying predictably broken archives. Do not silently fall back to application-managed origin auth, public asset buckets, framework development servers, missing native dependencies, shared dynamic caches, or ordinary Function URL OAC.

Use bounded startup and HTTP timeouts, terminate local test servers, and keep test fixtures self-contained. Stream heartbeats/read timeouts must account for CloudFront's origin read timeout as well as the Web Function request timeout. Do not claim full-duplex streaming or WebSocket support.

If the selected framework version cannot meet a required capability, report the precise failure and revisit that requirement rather than substituting a lower-level h3/React demo and calling it framework support.

## Sources

- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-configuration.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-env-lifecycle.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-http.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html

Local `aws-serverless` and `aws-networking` routing skills were checked. The specialized `aws-lambda-web-functions` and `cloudfront` skill files were unavailable locally and no authoritative remote skill source was established; service facts above come from the official documentation instead.
