# Framework Web Function Constructs Design

- **Status:** Draft for review
- **Date:** 2026-11-19
- **Source decision record:** Grilling session, 2026-11-19 (decisions logged at the bottom)

## 1. Summary

Add four library-level CDK constructs — `NextJsWebFunction`, `TanStackWebFunction`,
`NuxtWebFunction`, and `AstroWebFunction` — that encapsulate the per-framework wiring
currently duplicated in `examples/fullstack/*/stack.ts` (artifact layout, static asset
routing, runtime defaults), and make the Lambda Web Function's execution role grantable
so consumers can attach permissions to AWS services such as DynamoDB, S3, and SQS.
A new minimal `examples/fullstack/astro` example proves the Astro construct against a
real build, and the three existing examples are refactored to use the new constructs
(dogfooding). No AWS deployment is performed in this change.

## 2. Goals

1. One-call framework stacks: `new TanStackWebFunction(scope, "App", { artifactDirectory })`
   produces the same resources consumers hand-assemble today.
2. Permissions are first-class: consumers can grant the function's revision execution
   role access to DynamoDB tables, S3 buckets, SQS queues — or any other resource —
   through standard CDK grant APIs.
3. Framework conventions (entrypoint, asset prefix, layout) live in exactly one place
   instead of being re-declared per consumer.
4. Every construct is proven against a real built artifact of its framework; nothing
   ships from convention alone.
5. Existing behavior is preserved: the three existing example stacks keep their
   current resource semantics after refactoring onto the constructs.

## 3. Non-goals

- No AWS deployment or live verification in this change; that stays behind its usual
  separate explicit bounded approval.
- No changes to the KEYALL 1-second dynamic cache policy or `WebFunctionDelivery`
  behavior.
- No framework version changes in the existing examples (Next.js, Nuxt, TanStack keep
  their pinned versions).
- No static-only Astro mode (CloudFront + S3 without a function). Astro is supported in
  SSR mode only for v1.
- No per-service grant granularity options beyond the defaults in §6.2; the
  `grantPrincipal` escape hatch covers custom cases.

## 4. Current state (facts this design builds on)

- `WebFunction` (`src/web-function.ts`) creates a revision execution `Role`
  (`aws-iam.Role`, line ~456) but keeps it private. There is no `executionRole`
  accessor and no `grantPrincipal`, so consumers cannot attach service permissions.
- Each example stack duplicates the same composition: `WebFunction` with
  `artifact: { directory, entrypoint: "index.js" }`, `IAM_AUTH`, `HOME_REGION`,
  `endpointName: "prod"`, plus `WebFunctionDelivery` with one asset mapping:
  - Next.js: `.next/static` → `/_next/static/`
  - Nuxt: `.output/public/_nuxt` → `/_nuxt/`
  - TanStack: `dist/client/assets` → `/assets/` (plus `SESSION_PASSWORD` /
    `NODE_ENV=production` env wiring via the shared session-secret helper)
- `WebFunctionDelivery` supports multiple asset mappings and rejects overlapping
  prefixes; `WebFunctionProps.environmentVariables` rejects the reserved
  `AWS_LAMBDA_HTTP_ENDPOINT` key.
- There is no Astro example or artifact pipeline. Astro's SSR output (with the
  `@astrojs/node` adapter) is `dist/client/` (static assets, content-hashed under
  `dist/client/_astro/`) and `dist/server/entry.mjs`; runtime packages remain
  external to the server bundle, so the artifact must stage runtime `node_modules`
  exactly like the TanStack example does.
- Tests live in `test/*.test.ts`; the full suite is currently 215/215 with JSII
  build and type checks clean.

## 5. Design

### 5.1 Construct family

```
WebFunction (existing; gains executionRole/grantPrincipal)
  └─ FrameworkWebFunctionBase (internal, not exported)
       ├─ NextJsWebFunction     entrypoint index.js, assets .next/static   → /_next/static/
       ├─ TanStackWebFunction   entrypoint index.js, assets dist/client/assets → /assets/
       ├─ NuxtWebFunction       entrypoint index.js, assets .output/public/_nuxt → /_nuxt/
       └─ AstroWebFunction      entrypoint index.js, assets dist/client/_astro → /_astro/
```

All four construct classes are exported from `src/index.ts` together with their
props interfaces and the permission types. The shared base stays internal to the
framework module family (it is imported across files but not re-exported from
`src/index.ts`).

**File layout (revised 2026-11-20, operator review):** one file per construct,
matching the repo's one-construct-per-file convention:

- `src/framework-web-function.ts` — shared base (`FrameworkWebFunctionBase`),
  `FrameworkWebFunctionProps`, the props zod schema, per-framework definitions,
  and permission types/validation
- `src/nextjs-web-function.ts` — `NextJsWebFunction`
- `src/tanstack-web-function.ts` — `TanStackWebFunction`
- `src/nuxt-web-function.ts` — `NuxtWebFunction`
- `src/astro-web-function.ts` — `AstroWebFunction`

### 5.2 Common props interface

```ts
/** One IAM permission statement applied to the revision execution role. */
export interface WebFunctionPermission {
  /** IAM actions, e.g. "dynamodb:GetItem" or ["s3:GetObject", "s3:PutObject"]. */
  readonly actions: string | string[];
  /** Resource ARNs for any AWS service. Pass the construct's ARN property
   *  directly — bucket.bucketArn, table.tableArn, queue.queueArn,
   *  topic.topicArn, cluster.clusterArn — or a literal ARN string. */
  readonly resources: string[];
}

export interface FrameworkWebFunctionProps {
  /** Prebuilt artifact root staged by the example's build-artifact.mjs. */
  readonly artifactDirectory: string;
  /** Name assigned to the Lambda Web Function. */
  readonly functionName: string;
  /** Endpoint name; default "prod". */
  readonly endpointName?: string;
  /** Environment variables passed to the revision. */
  readonly environmentVariables?: { readonly [key: string]: string };
  /** IAM permission statements applied to the execution role. Always Allow. */
  readonly permissions?: WebFunctionPermission[];
  /** Asset bucket removal policy; RETAIN by default, matching WebFunctionDelivery. */
  readonly removalPolicy?: RemovalPolicy;
  /** Optional endpoint scaling, throttle, timeout, and logging pass-through. */
  // scalingConfig, throttleConfig, timeoutSeconds, maxConcurrencyPerEnvironment,
  // and loggingConfig are passed through to WebFunction unchanged.
}
```

Note (revision 2, 2026-11-20): the arrays are non-readonly `string[]` because jsii
rejects `readonly X[]`/`ReadonlyArray<X>` property types (JSII3001) and anonymous
inline object types in unions (JSII1003). The construct-object resource form was
therefore dropped in favor of ARN strings — matching the operator's pre-authorized
fallback ("let the user simply add an array of object { actions, resources:
[S3Bucket.arn, ...] }") — with consumers passing any construct's ARN property.
IBucket, ITable, and IQueue expose `bucketArn`/`tableArn`/`queueArn`, not `.arn`,
so the earlier `.arn`-object claim was incorrect in any case.

Common behavior:

- `artifact: { directory: props.artifactDirectory, entrypoint: "index.js" }` — the
  launcher convention is fixed per construct, not configurable.
- `authType` is fixed to `IAM_AUTH` and `endpointType` to `HOME_REGION` and are NOT
  props: the mandatory internal `WebFunctionDelivery` hard-requires exactly that
  combination (same-stack, IamAuth, HomeRegion), so exposing knobs that the delivery
  would reject with a delivery-level error is a dead surface. `cognito` is likewise
  not exposed because it requires `APPLICATION_MANAGED`. Consumers needing other
  auth/endpoint/Cognito combinations use `WebFunction` + `WebFunctionDelivery`
  directly.
- `NODE_ENV=production` is set automatically unless the consumer overrides it in
  `environmentVariables`.
- The framework asset mapping is built from `artifactDirectory` and the per-framework
  directory/prefix constants. Consumers who need custom mappings use `WebFunction` +
  `WebFunctionDelivery` directly.
- Layout validation at synthesis: the construct verifies the expected launcher and
  asset directory exist under `artifactDirectory` (same spirit as the existing
  `WebFunctionProps` artifact zod checks) and fails with a framework-specific message
  pointing at the build-artifact script.
- Permissions: after constructing `WebFunction`, each entry in `permissions`
  becomes one Allow `PolicyStatement` on the execution role (actions from
  `actions`, resources used verbatim as the ARNs). Grants are additive; zero
  entries means no policy changes. The effect is always `Allow` (operator
  decision 2026-11-20); Deny is out of scope.

### 5.3 Public surface of `WebFunction` (additive, non-breaking)

```ts
/** The revision execution role. Use this to grant the function access to AWS services. */
public readonly executionRole: Role;
/** Grant principal for standard CDK grant APIs, e.g. table.grantReadWriteData(fn.grantPrincipal). */
public get grantPrincipal(): IGrantable;
```

This is the prerequisite change that makes the permissions story work for any AWS
service, not just the three convenience targets.

### 5.4 Permissions (revised 2026-11-20, operator review)

The original typed convenience keys (`dynamodb`/`s3`/`sqs` with hardcoded
`grantReadWriteData`/`grantReadWrite`/`grantSendMessages` calls and duck-typed
predicates pinning `tableArn`/`bucketArn`/`queueArn`) were dropped at operator
review: they limited permissions to three services and encoded coarse
least-unreviewed action sets. The replaced design is a plain statement list
(§5.2): the consumer names the exact IAM actions and passes resource ARN
strings for any AWS service — a construct's ARN property
(`bucket.bucketArn`, `table.tableArn`, `queue.queueArn`, `topic.topicArn`,
`cluster.clusterArn`) or a literal ARN. An earlier revision sketched an
object form read via `.arn`, but the mainstream CDK resource interfaces do
not expose `.arn` (they expose `bucketArn`/`tableArn`/`queueArn`/…) and jsii
rejects anonymous inline object unions anyway (JSII1003), so resources are
strings only — matching the operator's pre-authorized fallback.

Validation at synthesis: `actions` must be a non-empty string or non-empty
array of non-empty strings; `resources` must be a non-empty array of
non-empty strings. No duck-typed construct checks remain — nothing has a
runtime class to check, and the typed surface carries the contract.

### 5.5 Astro example (`examples/fullstack/astro`)

New minimal example following the established fullstack example pattern:

- **App**: SSR home page with a request-time timestamp, `/about` page, a validated
  server mutation endpoint (same shape as `/api/square` in the other examples),
  `/__probe/identity` marker route, mutable `robots.txt` in `public/`. No auth, no
  database, no Tailwind — matching the approved stateless fullstack demo scope.
- **Build**: `astro.config.mjs` with the `@astrojs/node` adapter in `mode: "local"`;
  the adapter's built server (`dist/server/entry.mjs`) exports its request handler
  rather than binding its own listener, which is what makes the launcher contract
  below implementable (standalone mode would bind `process.env.PORT` itself and
  hide the bound port, breaking the port-0 + `READY` contract shared by the probe
  harness). `build:artifact` (`build-artifact.mjs`) stages `dist/client`,
  `dist/server`, the launcher `index.js`, and the runtime `node_modules` subset
  required by the server bundle (same approach as the TanStack example, including
  the `.bin` symlink exclusion and traversal-safe staging).
- **Launcher**: same contract as the other examples — parse `AWS_LAMBDA_HTTP_ENDPOINT`
  (including port 0), host the adapter's request handler on the launcher's own
  `node:http` server, emit `READY:<bound port>`, serve `/_astro/` statics and the
  probe route, refuse unparseable endpoints.
- **Versions**: `astro@^5` with `@astrojs/node@^9` pinned in `bun.lock`; no other new
  runtime dependencies.
- **Stack**: `AstroExampleStack` composes `AstroWebFunction` (dogfooding §5.7).
- **Tests**: `test/fullstack-astro.test.ts` mirrors `test/fullstack-nuxt.test.ts`:
  artifact staging/layout, extracted ZIP startup + SSR, mutation valid/invalid,
  hashed `/_astro/` asset serving, `robots.txt`, launcher endpoint/error cases, probe
  identity gating.

### 5.6 Documentation

- Root `README.md`: add the four constructs to the construct list with a short
  permissions example.
- `examples/fullstack/shared/README.md`: mention the new astro example.
- New `examples/fullstack/astro/README.md` following the nuxt/tanstack README shape.
- JSDoc + a short TypeDoc usage snippet on each construct (Mermaid diagrams are not
  required for these additions; existing diagrams remain).

### 5.7 Dogfooding the existing examples

`nextjs/stack.ts`, `nuxt/stack.ts`, and `tanstack-start/stack.ts` are refactored to
construct the corresponding framework construct with the same function names, the
TanStack session-secret wiring preserved via `environmentVariables`, and an explicit
`removalPolicy: RemovalPolicy.DESTROY` pass-through in all three — the examples
currently set `DESTROY` on their asset buckets, and omitting it would silently flip
them to the construct's RETAIN default, orphaning buckets on delete (this also
touches the intentionally retained live TanStack deployment, so the refactor tests
assert the DESTROY pass-through explicitly). Because the constructs now set
`NODE_ENV=production` by default, the Next.js and Nuxt example templates gain that
environment variable (a functional no-op change asserted in their tests where
needed). Acceptance is that focused and full test suites pass with the same
live-behavior contract (SSR, assets, mutations, probes), not byte-identical
CloudFormation output; the TanStack stack additionally keeps its public
`sessionPassword` prop API unchanged.

## 6. Testing

1. **`src/` unit tests** (extend `test/web-function.test.ts` or add
   `test/framework-web-function.test.ts`):
   - `WebFunction` exposes `executionRole` and `grantPrincipal`; grants added via
     `grantPrincipal` land on the revision execution role in the synthesized template.
   - Each framework construct synthesizes the expected Web Function config
     (entrypoint, auth, endpoint, `NODE_ENV=production` default and override) and the
     expected single asset mapping with its framework prefix.
   - `permissions` statements produce the expected IAM policy statements (revised
     2026-11-20: generic statement tests — actions string vs array, single vs
     multiple ARN resources, multiple statements, and an ARN from a
     non-DynamoDB/S3/SQS service such as an SNS `topicArn`), not per-service
     grant tests.
   - Layout validation rejects a missing launcher and a missing asset directory with
     framework-specific messages.
   - Props defaults: endpointName "prod", IAM_AUTH/HOME_REGION, RETAIN bucket policy
     pass-through.
2. **Astro example tests**: as §5.5, run against `examples/fullstack/artifacts/astro`
   built by `bun run build:artifact` inside the example.
3. **Existing suites**: all existing tests continue to pass after the example
   refactors; suite count grows (new astro + construct tests).
4. **Gates before completion**: `bun test` full suite green; `bun run build` (JSII)
   0 errors/0 warnings; `bun run test:types` passes. Arm64 artifact rebuild is NOT in
   scope for this change (no live deployment is planned), except that the astro
   example's native artifact must build and pass locally.

## 7. Risks and mitigations

- **Role exposure widens the blast radius**: exposing `executionRole` lets consumers
  grant anything, including broad policies. Mitigation: document that the role is
  application-owned; grants remain opt-in and additive; no default permissions change.
- **Astro version churn**: Astro 5 and `@astrojs/node` 9 evolve quickly. Mitigation:
  pin via `bun.lock` and gate the example on its own test file; artifact staging is
  isolated in the example.
- **Grant defaults are coarse**: `grantReadWriteData`/`grantReadWrite` are broader
  than many apps need. Mitigation: document the exact actions table; consumers needing
  least privilege use `grantPrincipal` with custom `PolicyStatement`s.
- **`NODE_ENV=production` default changes existing example synthesis** (Next.js and
  Nuxt gain it). Mitigation: update the affected assertions and note it in the plan;
  behavior on the platform is unchanged (production mode was already implied by the
  standalone/server build outputs).
- **Artifact staging complexity for Astro** (runtime `node_modules`, `.bin` symlink
  filtering). Mitigation: reuse the proven TanStack staging approach including the
  symlink-escape fix (`cpSync` dereference filtering of `.bin`), and test startup from
  the extracted ZIP.

## 8. Decisions record (from the grilling session, 2026-11-19)

| # | Decision | Choice |
|---|---|---|
| Q1 | Placement | Library-level constructs in `src/`, exported from `index.ts` |
| Q2 | Permissions API | Public `executionRole`/`grantPrincipal` core + typed `permissions` conveniences for DynamoDB/S3/SQS. **Superseded 2026-11-20 (operator review):** typed conveniences dropped in favor of generic `WebFunctionPermission` statements (`actions` + `resources` as ARN strings — any construct's ARN property or a literal ARN), always Allow |
| Q3 | Astro | Build the minimal `examples/fullstack/astro` example; no convention-only construct |
| Q4 | Astro modes | SSR only (`@astrojs/node`); no static-only mode in v1 |
| Q5 | Encapsulation | Constructs compose `WebFunction` + `WebFunctionDelivery` internally, expose both as readonly properties, curated pass-through props; `authType`/`endpointType`/`cognito` are not props because the mandatory delivery requires IAM_AUTH + HOME_REGION (review finding) |
| Q6 | Naming | `TanStackWebFunction` (official framework casing) |
| Q7 | Dogfooding | Refactor the three existing example stacks onto the constructs |
| Q8 | Env conventions | No session special-casing; `NODE_ENV=production` set by the construct; plain `environmentVariables` passthrough |

Supervisor-resolved leaves (precedent-based, not user-contested):

- Astro example app scope mirrors the approved stateless fullstack demo (SSR home with
  timestamp, `/about`, validated server mutation, probe identity, no auth, no DB).
- Grant defaults: `grantReadWriteData` (DynamoDB), `grantReadWrite` (S3),
  `grantSendMessages` (SQS).
- No package version bump in this change; release/versioning remains a separate
  decision.
- No AWS deployment; live gates unchanged.
