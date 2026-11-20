# Framework Web Function Constructs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Library-level `NextJsWebFunction`, `TanStackWebFunction`, `NuxtWebFunction`, and `AstroWebFunction` constructs with a grantable execution role and typed permissions, proven by a new Astro example and dogfooding of the three existing examples.

**Architecture:** A single internal base construct composes `WebFunction` + `WebFunctionDelivery` with per-framework artifact-layout constants (launcher entrypoint, asset directory, URL prefix). `WebFunction` gains a public `executionRole`/`grantPrincipal`; the framework constructs apply optional `permissions` grants (DynamoDB read/write data, S3 read/write, SQS send) to that role. A new minimal `examples/fullstack/astro` example (SSR, `@astrojs/node` `mode: "local"`) proves the Astro construct against a real artifact.

**Tech Stack:** AWS CDK v2 (TypeScript, jsii), zod, bun test, Astro 5 + `@astrojs/node` 9 (example only).

**Spec:** `docs/superpowers/specs/2026-11-19-framework-constructs-design.md` (approved, commits `48f887f`/`42c8754`/`d125465`).

---

## File structure

- Modify: `src/web-function.ts` — expose `executionRole` (readonly `Role`) and `grantPrincipal` on `WebFunction`.
- Create: `src/framework-web-function.ts` — internal base + `FrameworkWebFunctionProps` + `WebFunctionPermissions` + the four public construct classes (one file; they change together).
- Modify: `src/index.ts` — export the new constructs/types.
- Create: `test/framework-web-function.test.ts` — construct synthesis, layout validation, permissions grants.
- Modify: `test/web-function.test.ts` — execution-role exposure tests.
- Create: `examples/fullstack/astro/` — app (`astro.config.mjs`, `src/pages/*`, `public/`), `index.js` launcher, `build-artifact.mjs`, `stack.ts`, `tsconfig.json`, `package.json`, `README.md`.
- Create: `test/fullstack-astro.test.ts` — mirrors `test/fullstack-nuxt.test.ts`.
- Modify: `examples/fullstack/{nextjs,nuxt,tanstack-start}/stack.ts` — dogfood the constructs.
- Modify: `test/fullstack-{nextjs,nuxt,tanstack-start}.test.ts` — only where synthesis assertions need the new `NODE_ENV` default.
- Modify: `README.md`, `examples/fullstack/shared/README.md` — construct list + astro example mention.
- Modify: this plan — task execution records.

Rules all tasks follow:

- TDD: RED step first (run focused test, see it fail for the right reason), then implement, then GREEN.
- Commits per task; never commit secrets; no AWS calls; do not run the existing frameworks' builds beyond what tasks specify.
- Node ≥24 toolchain; run everything from the repo root unless a step says otherwise.
- The full suite baseline is **215 pass / 0 fail** on `main` before any task.

---

### Task 1: Expose the revision execution role on WebFunction

**Files:**
- Modify: `src/web-function.ts` (role created ~line 456 inside the private upload path; class property block ~lines 216–229)
- Test: `test/web-function.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/web-function.test.ts`. The file uses inline props (no `minimalProps` helper exists — create one or keep the inline form the file already uses; a synthesizable `WebFunction` needs an entry file + functionName + auth/endpoint/endpointName as the existing tests do). Use the file's existing `Match`-based template style (`test/web-function.test.ts:98-113`):

```ts
test("exposes the revision execution role for grants", () => {
  const app = new App();
  const stack = new Stack(app, "Stack");
  const fn = new WebFunction(stack, "Fn", minimalProps("expose-role"));
  expect(fn.executionRole).toBeInstanceOf(Role);
  // Grants via the standard CDK API must land on the same role
  const role = fn.executionRole;
  expect(fn.grantPrincipal).toBe(role);
  const template = Template.fromStack(stack);
  // WebFunction already adds its own CloudWatch-logs statement to this policy, so
  // the caller-side grant lands at index >= 1 — match by content, not index.
  role.addToPrincipalPolicy(new PolicyStatement({
    actions: ["dynamodb:GetItem"],
    resources: ["arn:aws:dynamodb:eu-central-1:123456789012:table/demo"],
  }));
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Action: "dynamodb:GetItem" })]),
    }),
  });
});
```

Import `Role` from `aws-cdk-lib/aws-iam` and `PolicyStatement` as needed; keep the test consistent with the file's existing style/imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/web-function.test.ts`
Expected: FAIL — `executionRole` is `undefined` (TypeError accessing property / expect failure).

- [ ] **Step 3: Implement**

In `src/web-function.ts`:
- Add class fields:

```ts
/** The revision execution role. Use this to grant the function access to AWS services. */
public readonly executionRole: Role;
/** Grant principal for standard CDK grant APIs, e.g. table.grantReadWriteData(fn.grantPrincipal). */
public get grantPrincipal(): IGrantable {
  return this.executionRole;
}
```

- Where the role is created (`const iamRole = new Role(...)` in the private upload path), assign `this.executionRole = iamRole;` immediately after construction.
- Add `IGrantable` to the `aws-cdk-lib/aws-iam` imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/web-function.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/web-function.ts test/web-function.test.ts
git commit -m "Expose WebFunction revision execution role"
```

---

### Task 2: Framework construct base, NextJsWebFunction, and permissions

**Files:**
- Create: `src/framework-web-function.ts`
- Modify: `src/index.ts`
- Test: `test/framework-web-function.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `test/framework-web-function.test.ts`. Reuse the existing web-function test file's helpers for building a minimal valid artifact directory (a temp directory containing `index.js` launcher file + the framework's asset directory; see how existing example tests stage artifacts — a plain directory with the required files is enough for synthesis-only tests).

```ts
// Synthesis: defaults
test("NextJsWebFunction synthesizes function and delivery with framework defaults", () => {
  const app = new App();
  const stack = new Stack(app, "Stack");
  const site = new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"), // temp dir: index.js + .next/static/
    functionName: "my-site",
  });
  expect(site.webFunction).toBeInstanceOf(WebFunction);
  expect(site.delivery).toBeInstanceOf(WebFunctionDelivery);
  const template = Template.fromStack(stack);
  // revision env gains NODE_ENV=production by default
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { NODE_ENV: "production" } },
  });
  // Fixed auth/endpoint defaults required by the internal delivery
  template.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
    AuthType: "IamAuth",
    EndpointType: "HomeRegion",
  });
  // TWO BucketDeployments: WebFunction's code deployment AND the delivery's
  // static-assets deployment (one per mapping) — do not assert 1.
  template.resourceCountIs("Custom::CDKBucketDeployment", 2);
  // RETAIN is the delivery's default removal policy
  template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
});

// NODE_ENV override
test("consumer can override NODE_ENV", () => { /* environmentVariables: { NODE_ENV: "test" } → revision has NODE_ENV: "test" */ });

// Layout validation
test("rejects a missing launcher file and a missing asset directory with framework-specific messages", () => {
  // artifactDir without index.js → /launcher/i message naming Next.js
  // artifactDir without .next/static → /static asset/i message
});

// endpointName default
test("endpoint name defaults to prod", () => {
  // assert the synthesized endpoint resource name/property carries "prod"
});

// Permissions: one test per service plus combined
test("permissions.dynamodb grants read/write data access", () => {
  const table = new Table(stack, "Table", { partitionKey: { name: "id", type: AttributeType.STRING } });
  new NextJsWebFunction(stack, "Site", { artifactDirectory, functionName: "p", permissions: { dynamodb: [table] } });
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::IAM::Policy", {
    // Match by content: the role's default policy already carries the logs grant,
    // so grants never sit at a fixed index.
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]),
      })]),
    }),
  });
});
// s3 → bucket.grantReadWrite → hasResourceProperties("AWS::IAM::Policy", { Action: ["s3:GetObject*", …] })
// sqs → queue.grantSendMessages → Action: ["sqs:SendMessage", "sqs:SendMessageBatch"]
// combined test: all three arrays with two elements each → exactly the union appears
```

Exact expected action lists: copy from `aws-cdk-lib` grant docs at implementation time (assert `Action` arrays contain `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Query`, `s3:GetObject*`, `s3:PutObject*`, `sqs:SendMessage` at minimum).

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/framework-web-function.test.ts`
Expected: FAIL — module not found (`src/framework-web-function.ts` does not exist).

- [ ] **Step 3: Implement**

Create `src/framework-web-function.ts`:

```ts
import { RemovalPolicy } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { IQueue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { z } from "zod";
import { WebFunction } from "./web-function";
import { WebFunctionDelivery } from "./web-function-delivery";
import { WebFunctionAuthType, WebFunctionEndpointType } from "./web-function-options";
```

Exports:
- `WebFunctionPermissions` (dynamodb?: ITable[]; s3?: IBucket[]; sqs?: IQueue[])
- `FrameworkWebFunctionProps` — per spec §5.2: `artifactDirectory`, `functionName`, `endpointName?` (default `"prod"`), `environmentVariables?`, `permissions?`, `removalPolicy?`, plus pass-through `scalingConfig?`, `throttleConfig?`, `timeoutSeconds?`, `maxConcurrencyPerEnvironment?`, `loggingConfig?`, `description?`. No `authType`/`endpointType`/`cognito` (fixed by the internal delivery; document why in the interface JSDoc).
- `NextJsWebFunction`, `TanStackWebFunction`, `NuxtWebFunction`, `AstroWebFunction`.

Internal per-framework definition (asset dir relative to artifactDirectory, URL prefix):

| Construct | asset directory | url prefix |
|---|---|---|
| NextJsWebFunction | `.next/static` | `/_next/static/` |
| TanStackWebFunction | `dist/client/assets` | `/assets/` |
| NuxtWebFunction | `.output/public/_nuxt` | `/_nuxt/` |
| AstroWebFunction | `dist/client/_astro` | `/_astro/` |

Zod schema (mirror `WebFunctionPropsSchema` conventions in `src/web-function.ts`):

- `functionName` min 1; `artifactDirectory` non-empty; `endpointName` min 1.
- `environmentVariables`: reject reserved `AWS_LAMBDA_HTTP_ENDPOINT` (same superRefine pattern as `src/web-function.ts:192-194`).
- Permissions arrays: duck-typed predicates (no runtime classes exist for `ITable`/`IBucket`/`IQueue`): e.g. `z.custom<ITable>((v) => typeof v === "object" && v !== null && typeof (v as { tableArn?: unknown }).tableArn === "string", { message: "Expected a DynamoDB ITable construct" })`; analogues with `bucketArn` / `queueArn`.

Base class (internal, not exported):

```ts
class FrameworkWebFunctionBase extends Construct {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps, framework: FrameworkDefinition) {
    super(scope, id);
    const parsed = frameworkPropsSchema.parse(props);

    // Layout validation: launcher + asset directory must exist under artifactDirectory
    const artifactRoot = realpathSync(parsed.artifactDirectory);   // throws with framework-specific message if absent
    assertFile(path.join(artifactRoot, framework.launcher), `${framework.name} artifact must contain ${framework.launcher}`);
    assertDirectory(path.join(artifactRoot, framework.assetDirectory), `${framework.name} artifact must contain ${framework.assetDirectory}`);

    this.webFunction = new WebFunction(this, "App", {
      artifact: { directory: parsed.artifactDirectory, entrypoint: framework.launcher },
      functionName: parsed.functionName,
      authType: WebFunctionAuthType.IAM_AUTH,          // fixed: delivery requires it
      endpointType: WebFunctionEndpointType.HOME_REGION, // fixed: delivery requires it
      endpointName: parsed.endpointName ?? "prod",
      environmentVariables: { NODE_ENV: "production", ...parsed.environmentVariables },
      description: parsed.description,
      scalingConfig: parsed.scalingConfig,
      throttleConfig: parsed.throttleConfig,
      timeoutSeconds: parsed.timeoutSeconds,
      maxConcurrencyPerEnvironment: parsed.maxConcurrencyPerEnvironment,
      loggingConfig: parsed.loggingConfig,
    });

    this.delivery = new WebFunctionDelivery(this, "Delivery", {
      webFunction: this.webFunction,
      staticAssets: [{ directory: path.join(parsed.artifactDirectory, ...framework.assetDirectory), urlPrefix: framework.urlPrefix }],
      removalPolicy: parsed.removalPolicy,
    });

    const role = this.webFunction.executionRole;
    parsed.permissions?.dynamodb?.forEach((table) => table.grantReadWriteData(role));
    parsed.permissions?.s3?.forEach((bucket) => bucket.grantReadWrite(role));
    parsed.permissions?.sqs?.forEach((queue) => queue.grantSendMessages(role));
  }
}
```

The four public classes are thin: each calls `super(scope, id, props, definition)` where the definition carries `{ name, launcher: "index.js", assetDirectory: [...], urlPrefix }`. JSDoc on each class names the framework, its asset prefix, and shows a permissions example.

Modify `src/index.ts`: export the four classes plus `WebFunctionPermissions` and `FrameworkWebFunctionProps`.

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/framework-web-function.test.ts test/web-function.test.ts test/web-function-delivery.test.ts`
Expected: PASS.

- [ ] **Step 5: JSII + types gate**

Run: `bun run build && bun run test:types`
Expected: JSII 0 errors/0 warnings; types pass.

- [ ] **Step 6: Commit**

```bash
git add src/framework-web-function.ts src/index.ts test/framework-web-function.test.ts
git commit -m "Add framework Web Function constructs with permissions"
```

---

### Task 3: TanStack and Nuxt constructs validated against real examples

**Files:**
- Test: `test/framework-web-function.test.ts` (extend)
- Modify: `examples/fullstack/tanstack-start/stack.ts`, `examples/fullstack/nuxt/stack.ts` (dogfood)
- Modify: `test/fullstack-tanstack-start.test.ts`, `test/fullstack-nuxt.test.ts` (assertion updates only where needed)

- [ ] **Step 1: Write failing tests (construct synthesis + dogfood equivalence)**

Extend `test/framework-web-function.test.ts`:

```ts
test("TanStackWebFunction maps dist/client/assets to /assets/ and sets NODE_ENV", () => { /* like Task 2 tests, prefix /assets/ */ });
test("NuxtWebFunction maps .output/public/_nuxt to /_nuxt/", () => { /* prefix /_nuxt/ */ });

// Spec §5.7: the dogfooded TanStack stack must pass removalPolicy DESTROY explicitly
// (its asset bucket backs the intentionally retained live deployment).
test("dogfooded TanStack example stack sets asset bucket removal policy to DESTROY", () => {
  const app = new App();
  const stack = new TanStackStartExampleStack(app, "Stack", {
    env: { account: "123456789012", region: "eu-central-1" },
    artifactDirectory: artifactDir("tanstack"), // temp dir: index.js + dist/client/assets
    sessionPassword: "x".repeat(32),
  });
  Template.fromStack(stack).hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
});
```

- [ ] **Step 2: RED run**

Run: `bun test test/framework-web-function.test.ts`
Expected: the two new tests fail (classes exist after Task 2 — if they pass immediately because Task 2 already built them, verify the tests actually exercise the right prefixes and proceed; the RED requirement applies to the dogfood equivalence step below).

- [ ] **Step 3: Dogfood the TanStack stack**

Rewrite `examples/fullstack/tanstack-start/stack.ts` to compose `TanStackWebFunction`:

```ts
export class TanStackStartExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: TanStackStartExampleStackProps) {
    super(scope, id, props);
    const sessionPassword = readSessionPassword(props.sessionPassword);
    const site = new TanStackWebFunction(this, "App", {
      artifactDirectory: props.artifactDirectory,
      functionName: "fullstack-tanstack-start",
      environmentVariables: { SESSION_PASSWORD: sessionPassword },
      removalPolicy: RemovalPolicy.DESTROY, // spec §5.7: explicit DESTROY pass-through
    });
    this.webFunction = site.webFunction;
    this.delivery = site.delivery;
  }
}
```

Public prop API (`sessionPassword`) unchanged; `NODE_ENV=production` now comes from the construct.

- [ ] **Step 4: Dogfood the Nuxt stack**

Rewrite `examples/fullstack/nuxt/stack.ts` the same way with `NuxtWebFunction`, `functionName: "fullstack-nuxt"`, `removalPolicy: RemovalPolicy.DESTROY`.

- [ ] **Step 5: Run focused example suites**

Run: `bun test test/fullstack-tanstack-start.test.ts test/fullstack-nuxt.test.ts test/framework-web-function.test.ts`
Expected: PASS. If a synthesis assertion fails because `NODE_ENV=production` was previously absent (Nuxt) or the delivery ID changed, update the assertion to the new (equivalent) shape — behavioral contract (SSR/assets/mutations/probes) must not change. The TanStack test asserting `NODE_ENV=production` in revision env keeps passing.

- [ ] **Step 6: Full-suite sanity**

Run: `bun test`
Expected: 215+ pass / 0 fail (count grows only if new tests were added).

- [ ] **Step 7: Commit**

```bash
git add examples/fullstack/tanstack-start/stack.ts examples/fullstack/nuxt/stack.ts test/
git commit -m "Dogfood TanStack and Nuxt constructs in examples"
```

---

### Task 4: Dogfood the Next.js stack

**Files:**
- Modify: `examples/fullstack/nextjs/stack.ts`
- Modify: `test/fullstack-nextjs.test.ts` (assertion updates only where needed)

- [ ] **Step 1: Refactor**

`NextjsExampleStack` composes `NextJsWebFunction` with `functionName: "fullstack-nextjs"` and `removalPolicy: RemovalPolicy.DESTROY` (spec §5.7). Expose `.webFunction`/`.delivery` as today.

- [ ] **Step 2: RED→GREEN check**

Run: `bun test test/fullstack-nextjs.test.ts`
Expected: PASS after updating any assertion that lacked `NODE_ENV=production` (the revision env gains it; the standalone build already implied production mode, so no behavior change). Note the no-op env addition in the commit body.

- [ ] **Step 3: Full suite**

Run: `bun test`
Expected: all pass / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add examples/fullstack/nextjs/stack.ts test/fullstack-nextjs.test.ts
git commit -m "Dogfood NextJs construct in example stack"
```

---

### Task 5: Astro example app, launcher, and artifact pipeline

**Files:**
- Create: `examples/fullstack/astro/package.json`, `astro.config.mjs`, `tsconfig.json`, `.gitignore`, `src/pages/index.astro`, `src/pages/about.astro`, `src/pages/api/square.ts`, `public/robots.txt`, `index.js`, `build-artifact.mjs`, `stack.ts`, `README.md`

The example `.gitignore` is REQUIRED: the root `.gitignore` ignores `tsconfig.json` at any depth, and the tanstack example works around it with a `!tsconfig.json` negation. Without an example-local `.gitignore` containing `!tsconfig.json` (plus `dist/` and `*.tsbuildinfo`), the tsconfig gate can never be committed and Task 6/8 fail from a fresh checkout.
- Modify: `examples/fullstack/cdk-app.ts` (add `FullstackAstro` stack)
- Modify: `examples/fullstack/astro/package.json` via `bun install` (creates `bun.lock`)

App requirements (match the established stateless fullstack demo scope — no auth, no DB, no Tailwind):
- Home page (`src/pages/index.astro`): request-time timestamp rendered server-side, e.g. `<p id="ssr-time">Rendered on the server at {timestamp}</p>`; nav links to `/about`.
- About page (`src/pages/about.astro`): short static copy.
- Mutation endpoint (`src/pages/api/square.ts`): `POST`, JSON body `{ value }`, validates integer 0–1000 (same error contract as the other examples: 400 with a validation message), returns `{ result: n * n }`.
- `public/robots.txt`: mutable, static content.

- [ ] **Step 1: Scaffold the app + config**

`astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "local" }),
});
```

Pin dependencies exactly like the other examples: `astro@^5`, `@astrojs/node@^9`; scripts `dev`, `build` (`astro build`), `build:artifact` (`node build-artifact.mjs`). Run `bun install` in `examples/fullstack/astro` to produce `bun.lock`.

- [ ] **Step 2: Launcher (`index.js`)**

Mirror `examples/fullstack/tanstack-start/index.js` (proven pattern):

- Parse `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`; reject unparseable/empty before starting; support port 0).
- Import the adapter's request handler from `dist/server/entry.mjs` (`mode: "local"` exports the handler rather than binding a listener). Note this is an ADAPTATION of the tanstack launcher, not a copy: that launcher hosts via `srvx/node`, while Astro's handler is a Node-style `(req, res)` handler wired to the launcher's own `node:http` server. Expect the export to be a handler factory (createStandaloneHandler-style) rather than a ready handler; the Task 6 RED loop is the designed place to resolve the exact export shape.
- Create the launcher's own `node:http` server hosting the handler; `server.listen(port, host)`; emit `READY:<bound port>` after binding (port 0 → report the actual bound port).
- Serve `dist/client` statics with `/_astro/` prefix immutable cache headers (`public, max-age=31536000, immutable`) and correct content types; traversal guard (resolve + prefix check, like `tanstack-start/index.js:53`).
- Serve `/__probe/identity` returning the marker + port, gated by `FULLSTACK_PROBE_MARKER` (same contract as the other launchers).
- Emit the same error/exit behavior as the other launchers (unparseable endpoint → refuse before start; bound port → EADDRINUSE).

- [ ] **Step 3: Artifact staging (`build-artifact.mjs`)**

Mirror `examples/fullstack/tanstack-start/build-artifact.mjs`: stage `dist/client`, `dist/server`, `index.js`, `package.json`, and the runtime `node_modules` subtree into `../artifacts/astro/native-darwin-arm64` (the Astro server bundle keeps runtime packages external, exactly like TanStack). Include the `.bin` directory filtering and the dereference/symlink-escape fix (no `.bin`, no absolute symlinks escaping the artifact root).

- [ ] **Step 4: Stack (`stack.ts`)**

`AstroExampleStack` composing `AstroWebFunction` with `functionName: "fullstack-astro"`, `removalPolicy: RemovalPolicy.DESTROY`, exposing `.webFunction`/`.delivery`. Wire into `examples/fullstack/cdk-app.ts` as `FullstackAstro` (no session password needed — the example has no auth). Add a comment in `cdk-app.ts` noting the astro artifact is currently native-darwin-arm64 only (the shared `artifact("astro")` helper resolves linux-arm64, which is not built in this change — no test synthesizes `cdk-app.ts`, so a plain comment prevents a confusing future `cdk synth` failure).

- [ ] **Step 5: Build the artifact**

Run: `cd examples/fullstack/astro && bun run build:artifact`
Expected: `../artifacts/astro/native-darwin-arm64` contains `index.js`, `dist/client/_astro/*` (hashed), `dist/server/entry.mjs`, `node_modules/astro` present; no `.bin`. (The staging script spawns the framework build itself, like the tanstack staging script does — a separate `bun run build` would build twice.)

- [ ] **Step 6: Commit**

```bash
git add examples/fullstack/astro examples/fullstack/cdk-app.ts
git commit -m "Add Astro SSR Web Function example"
```

(Tests come next; commit the pipeline before the RED test so the RED failure is the test, not a missing build.)

---

### Task 6: Astro example tests

**Files:**
- Create: `test/fullstack-astro.test.ts`

- [ ] **Step 1: Write the test file (RED)**

Mirror `test/fullstack-nuxt.test.ts` structure, importing the shared probe harness (`examples/fullstack/shared/probe.ts`) the same way:

- Staged artifact: launcher + `dist/client/_astro` hashed assets + `dist/server/entry.mjs` + `node_modules/astro` present; no `.bin`.
- Extracted ZIP: synthesizes `FullstackAstro` with launcher entrypoint and `/_astro/` routed to S3 (assert via the stack class in `examples/fullstack/astro/stack.ts`, following the nuxt test's synthesis assertion approach); resolves literal server-side requires from the server output.
- Launcher behavior: refuses an unparseable endpoint before starting; fails to start when the port is already bound.
- Running the extracted artifact (with `AWS_LAMBDA_HTTP_ENDPOINT` incl. port 0 and the probe marker env): SSR home contains `Rendered on the server at` with a request-time timestamp bounded by wall clock (reuse the tanstack test's timestamp assertion approach); `/api/square` valid 7 → `{"result":49}` and invalid `-1` → 400 with the validation message; `/about` reachable; hashed `/_astro/` asset served with immutable cache headers and a content type; `robots.txt` 200 text/plain; probe identity 404 without the marker (unlike nuxt — whose probe route lives in the app — the astro launcher hosts it, so this needs a second spawn without `FULLSTACK_PROBE_MARKER`, adaptable from the nuxt test's launcher-spawn helper).
- `bunx tsc --noEmit -p tsconfig.json` clean (add a `tsconfig.json` mirroring the tanstack example's gate: `include: ["src", "index.js", "build-artifact.mjs", "stack.ts", "astro.config.mjs"]`, and extend `astro/tsconfigs/strict` with `"types": ["node"]` for the `.ts` sources — tsc does not typecheck `.astro` files, same as the tanstack gate).

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/fullstack-astro.test.ts`
Expected: FAIL where the implementation is wrong (e.g. launcher/staging gaps). Fix `examples/fullstack/astro` until green — this is the loop where Astro-specific surprises get resolved.

- [ ] **Step 3: GREEN**

Run: `bun test test/fullstack-astro.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 4: Full suite**

Run: `bun test`
Expected: all pass / 0 fail (215 baseline + new framework + astro tests).

- [ ] **Step 5: Commit**

```bash
git add test/fullstack-astro.test.ts examples/fullstack/astro
git commit -m "Test Astro Web Function example end to end"
```

(The artifact directory itself stays gitignored like the other examples'.)

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (root), `examples/fullstack/shared/README.md`
- Create: `examples/fullstack/astro/README.md` (if not already written in Task 5 — write it here if deferred)
- Modify: this plan (execution records)

- [ ] **Step 1: Root README**

Add the four constructs to the construct list with a short permissions snippet:

```ts
import { TanStackWebFunction } from "lambda-web-function-construct";

const site = new TanStackWebFunction(this, "Site", {
  artifactDirectory: "artifacts/tanstack/native-darwin-arm64",
  functionName: "my-site",
  permissions: {
    dynamodb: [table],   // grantReadWriteData: Get/Put/Update/Delete item, Query, Scan, Batch*, DescribeTable
    s3: [bucket],        // grantReadWrite: s3:GetObject*, s3:PutObject*, ListBucket, DeleteObject*
    sqs: [queue],        // grantSendMessages: sqs:SendMessage, sqs:SendMessageBatch
  },
});
// Anything else (least privilege or other services): use the role directly, e.g.
// table.grantReadWriteData(site.webFunction.grantPrincipal)
```

- [ ] **Step 2: Shared + astro READMEs**

- `examples/fullstack/shared/README.md`: mention the astro example in the example list.
- `examples/fullstack/astro/README.md`: build/dev/deploy instructions, the `/_astro/` asset routing note, launcher contract, and the fact that it has no auth/session (contrast with tanstack-start).

- [ ] **Step 3: Commit**

```bash
git add README.md examples/fullstack/shared/README.md examples/fullstack/astro/README.md
git commit -m "Document framework Web Function constructs"
```

---

### Task 8: Full verification gates and execution records

**Files:**
- Modify: this plan (check off tasks, add execution records with actual commands/results/SHAs)

- [ ] **Step 1: Run every gate**

From the repo root:
```bash
bun test                      # full suite: expect 215 baseline + all new tests, 0 fail
bun run build                 # JSII: 0 errors, 0 warnings
bun run test:types            # pass
cd examples/fullstack/astro && bunx tsc --noEmit -p tsconfig.json   # pass
cd examples/fullstack/tanstack-start && bunx tsc --noEmit -p tsconfig.json  # pass (unchanged gate)
```

- [ ] **Step 2: Record**

Add execution records to this plan for Tasks 1–7: what ran, actual results, commit SHAs, and any deviations. Check off all boxes.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-11-19-framework-constructs.md
git commit -m "Record framework constructs execution"
```

---

## Explicit non-goals (do not do in this plan)

- No AWS deployment, live rollout, or cleanup — none of these tasks may call AWS.
- No arm64 artifact rebuild for the existing examples; only the astro example's native artifact is built.
- No framework version changes in nextjs/nuxt/tanstack-start; no changes to KEYALL cache policy or delivery internals.
- No static-only Astro mode.
- No package version bump.

## Verification contract

- Focused RED runs must fail for the intended reason (record the failure output in the task record).
- Full suite green before each task commit that touches shared surfaces (`src/`, examples).
- Final gates: full suite + JSII + test:types + both tsconfig gates green.
