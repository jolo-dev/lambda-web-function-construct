# Lambda Web Function Construct

An AWS CDK construct for deploying a Node.js Lambda Web Function with a private code bucket, immutable revision, and HTTPS endpoint.

## Prerequisites

- Node.js 24 or later
- Bun on the machine running CDK synthesis, because the construct bundles the entry file with `bun build`
- AWS CDK v2

## Install

```sh
bun add lambda-web-function-construct aws-cdk-lib constructs
```

## Usage

```ts
import { App, Stack } from "aws-cdk-lib";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionEndpointType,
} from "lambda-web-function-construct";

const app = new App();
const stack = new Stack(app, "WebFunctionStack");

new WebFunction(stack, "WebFunction", {
  entry: "src/http.ts",
  functionName: "my-web-function",
  authType: WebFunctionAuthType.APPLICATION_MANAGED,
  endpointType: WebFunctionEndpointType.HOME_REGION,
  endpointName: "prod",
});

app.synth();
```

`WebFunctionAuthType` and `WebFunctionEndpointType` are typed classes with named constants, not TypeScript enums. They provide editor autocompletion and compile-time type checking while remaining JSII-compatible. Zod validates the underlying values and the supplied option instances during construct creation; plain strings are not accepted.

The entry point is bundled with Bun for Node.js and deployed as a Node.js 24 Lambda Web Function revision. The construct creates the private S3 code bucket, grants the Lambda service read access to the versioned ZIP, grants the revision execution role scoped CloudWatch Logs permissions for its centralized and `.local` log groups, and routes the endpoint to the generated revision.

## Optional Cognito authentication

For a separate browser frontend with signed-in users, pass the optional `cognito` parameter:

```ts
const api = new WebFunction(stack, "AuthenticatedApi", {
  entry: "src/http.ts", // Must verify Cognito access tokens on protected routes.
  functionName: "authenticated-api",
  endpointName: "prod",
  authType: WebFunctionAuthType.APPLICATION_MANAGED,
  endpointType: WebFunctionEndpointType.HOME_REGION,
  cognito: {
    domainPrefix: "my-unique-app-login",
    callbackUrls: ["https://app.example.com/auth/callback"],
    logoutUrls: ["https://app.example.com/"],
  },
});

// Available only when cognito is configured:
// api.userPool, api.userPoolClient, api.userPoolDomain
```

This creates a retained Cognito User Pool, a public app client **without a secret**, and a managed-login v2 domain with default branding. The client enables authorization code flow for frontend PKCE login, token revocation and refresh-token rotation. The pool disables public sign-up, requires authenticator-app TOTP MFA, and uses the Essentials feature plan. Access/ID tokens last 10 minutes; refresh tokens last 7 days. Review Cognito pricing and invite users before trying sign-in.

The construct injects `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` into the revision and outputs those IDs, the login domain, and the OIDC issuer. These environment-variable names are reserved when `cognito` is configured. `logoutUrls` defaults to `callbackUrls`; web redirect URLs must use HTTPS except for HTTP loopback development. Existing constructs are unchanged when the option is omitted.

**Provisioning Cognito does not automatically protect application routes.** The frontend sends `Authorization: Bearer <access_token>`; your application must verify it and enforce permissions. Cognito configuration requires `APPLICATION_MANAGED`, not `IAM_AUTH`. No Amplify, Better Auth, Identity Pool, or API Gateway is needed.

![AWS-icon architecture: separate frontend, Amazon Cognito, and a Lambda Web Function that verifies access tokens](examples/cognito/diagrams/cognito-architecture.png)

[Editable architecture diagram](examples/cognito/diagrams/cognito-architecture.excalidraw) · [Step-by-step OIDC flow](examples/cognito/OIDC_FLOW.md)

See **[Cognito-protected backend examples](examples/cognito/README.md)** for runnable [Hono](examples/cognito/hono/app.ts), [Express](examples/cognito/express/app.ts), and [Node HTTP](examples/cognito/node-http/app.ts) implementations, deployment instructions, exact-origin CORS, PKCE frontend integration, and offline authentication tests. These are separate from the benchmark examples.

User pools are retained on stack deletion or when removing the option; their stack-managed clients and domains are removed. Review retained pools explicitly before deleting user data.

## Framework Web Function constructs

`NextJsWebFunction`, `TanStackWebFunction`, `NuxtWebFunction`, and `AstroWebFunction` deploy a prebuilt framework artifact directory as a Lambda Web Function with its CloudFront delivery: content-hashed static assets are served from a private S3 bucket, all other traffic goes to an IAM-protected Web Function. `authType`, `endpointType`, and `cognito` are not props because the delivery hard-requires an IamAuth HomeRegion Web Function — compose the underlying `WebFunction` (with `WebFunctionDelivery` where its IamAuth/HomeRegion requirement fits) directly for other combinations. `endpointName` defaults to `"prod"`, `NODE_ENV` defaults to `"production"`, and the asset bucket defaults to `RemovalPolicy.RETAIN`. Synthesis never runs a framework build; stage the artifact first with the framework's `build:artifact` script.

```ts
import { TanStackWebFunction } from "lambda-web-function-construct";

const site = new TanStackWebFunction(this, "Site", {
  artifactDirectory: "examples/fullstack/artifacts/tanstack-start/native-darwin-arm64",
  functionName: "my-site",
  permissions: {
    dynamodb: [table], // grantReadWriteData: Get/Put/Update/Delete/ConditionCheck item, Query, Scan, Batch*, stream reads, DescribeTable
    s3: [bucket],      // grantReadWrite: s3:GetObject*, s3:PutObject (plus Tagging/Retention/LegalHold variants; no PutObjectAcl), s3:Abort*, s3:DeleteObject*; GetBucket*/List* on the bucket
    sqs: [queue],      // grantSendMessages: sqs:SendMessage
  },
});
// Anything else (least privilege or other services): use the role directly, e.g.
// table.grantReadWriteData(site.webFunction.grantPrincipal)
```

The comments list the actions emitted by the pinned aws-cdk-lib 2.274 grants; `grantSendMessages` additionally emits the queue-lookup actions `sqs:GetQueueAttributes` and `sqs:GetQueueUrl`.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then use the pinned Node.js 24.22.1 and Bun 1.4.4 toolchain:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun install --cwd examples --frozen-lockfile
mise exec -- bun run build
mise exec -- bun run test:types
mise exec -- bun run test:types:cognito
mise exec -- bun test
```

With mise activated in your shell, you can also run the Bun commands directly. Consumers require Node.js 24 or later; the mise pins select reproducible development versions.

CDK library, JSII, and JSII packaging versions are managed by `package.json` and `bun.lock`, not mise. The JSII tools use exact development dependency versions. The CDK CLI is a development dependency used to deploy the benchmark examples; it is not a runtime dependency of the construct.

`bun run build` invokes the local JSII compiler and emits the `.jsii` assembly used by Construct Hub to generate language-aware API documentation.

## Fullstack framework examples (local proof)

Production-server examples for **Next.js 16.4.6** (standalone), **Nuxt 4.6.4** (Nitro `node-server`), **TanStack Start 1.169.5**, and **Astro 5.18.2** (SSR, `@astrojs/node` mode `"local"`) live under [`examples/fullstack/`](examples/fullstack/). Each example stages a deployable artifact, deploys it through the matching framework construct — `NextJsWebFunction`, `NuxtWebFunction`, `TanStackWebFunction`, or `AstroWebFunction`, which composes `WebFunction` with `WebFunctionDelivery` (immutable static assets from private S3, dynamic traffic to an IAM-protected Web Function) — and has local extracted-artifact smoke tests proving SSR, a native server mutation with validation, navigation, and static/public asset serving. The Astro example is local proof only: its native artifact is built and smoke-tested, with no arm64 container build or live deployment yet. See the per-example READMEs and [`examples/fullstack/shared/README.md`](examples/fullstack/shared/README.md).

**Status:** local proof, local Linux Arm64 container proof, and **bounded live probes of Next.js and TanStack Start** using the operator-approved `KEYALL` cache policy (1-second TTL keyed on Authorization, all cookies, and all query strings). The earlier all-zero-TTL policy was rejected live; a viewer-function `x-forwarded-*` header error was found live and fixed with `x-public-*` headers. Nuxt was deployed, inspected, and **deleted on request**. TanStack Start with the stateless basic-auth flow was redeployed on 2026-11-19 and is **intentionally retained for viewing**: **https://d29nqdx0jywl18.cloudfront.net** (demo login `demo@example.com` / `demo-password`). See [`examples/fullstack/shared/live-resources.md`](examples/fullstack/shared/live-resources.md) for identifiers and cleanup commands. Browser hydration, streaming, and two-build old-asset retention remain unverified. All three artifacts were built in the pinned `linux/arm64` Node 24.22.1 container (`bash examples/fullstack/shared/build-arm64-artifacts.sh`); the runtime smoke covered the earlier pre-auth artifacts, and the post-auth TanStack rebuild was platform/artifact-content checked locally, with its live rollout the next gate. Further rollout is gated by [`examples/fullstack/shared/aws-checklist.md`](examples/fullstack/shared/aws-checklist.md). Build tooling never runs during CDK synthesis.

## Web Functions Benchmark

Start with **[Web Functions Benchmark](examples/benchmark/WEB_FUNCTIONS_BENCHMARK.md)**,
the consolidated summary of all local-process, LocalStack, real-AWS, oha, and
controlled-framework experiments, including cold starts, streaming, HTTP contracts,
cost assumptions, and practical conclusions. Each experiment remains separate so
results from different workloads and environments are not mistaken for one ranking.

The six examples and load generator live under [`examples/`](examples/). To run only the five local server processes—without LocalStack, AWS, or API Gateway—use:

```sh
bun install --frozen-lockfile
bun run bench:run:bare
```

This exercises `node-http`, Express, Hono, h3, and Bun against the same local workload suite. It starts and stops each server itself and writes timestamped JSON plus `examples/benchmark/results/bare-process-latest.json`. No AWS credentials, Docker, LocalStack, deployment, or AWS charges are required. Results are host-specific and are not directly comparable to the Frankfurt EC2 or AWS endpoint results.

To drive the same five local servers with [oha](https://github.com/hatoo/oha) instead of the built-in runner (requires `oha` on your PATH, e.g. `brew install oha`):

```sh
bun run bench:run:bare:oha
```

It uses the same servers, workloads, and concurrency matrix, with a 2-second warm-up and a 5-second measured run per cell. Results go to `examples/benchmark/results/bare-process-oha-latest.json` and a timestamped copy. Server CPU is not sampled in this mode.

The historical
[LocalStack report](examples/benchmark/RESULTS.md) is separate from the
[real AWS / LocalStack comparison](examples/benchmark/AWS_RESULTS.md), including cold starts,
cloud scaling, telemetry differences and corrected Frankfurt pricing. HTML dashboards are
`examples/benchmark/results/report.html` and `examples/benchmark/results/aws-report.html`.
The newer [oha concurrent I/O results](examples/benchmark/OHA_RESULTS.md) use longer runs
without the earlier temporary eight-environment cap; the older AWS report remains a
separate historical measurement.

LocalStack commands remain `bench:deploy`, `bench:run`, and `bench:report`. To target AWS
explicitly (public test endpoints; incurs charges):

```sh
python3 -m venv .venv-bench
.venv-bench/bin/pip install -r examples/benchmark/requirements-aws.txt
AWS_REGION=eu-central-1 bunx cdk diff --all --profile jolo \
  --app 'bun run examples/benchmark/cdk-app.ts' --no-change-set
AWS_REGION=eu-central-1 bun run bench:deploy:aws --profile jolo
BENCH_PYTHON=.venv-bench/bin/python bun run bench:run:aws --profile jolo --region eu-central-1
bun run bench:report:aws
```

AWS raw data uses `results/aws-latest.json` plus timestamped checkpoints; it never overwrites
LocalStack's `results/latest.json`. CloudWatch messages are preserved in checksum-verified
`aws-cloudwatch-*.json.gz` archives. The AWS runner uses equal concurrency levels, validates
application response bodies, checks revision identity during cold trials, and temporarily
caps each Web endpoint at eight environments (`--max-environments 2..16`). The API Gateway
example uses `/healthz` because AWS intercepts root `/ping` with a service-health response.

Original configuration is restored on ordinary errors. After process interruption, restore
the matching snapshot explicitly (replace the filename with the interrupted run's snapshot):

```sh
.venv-bench/bin/python examples/benchmark/aws-control.py --profile jolo --region eu-central-1 \
  restore < examples/benchmark/results/aws-snapshot-RUN_ID.json
```

Brief WAN measurements are not a substitute for a longer, co-located AWS capacity or billing
test. The deployed examples remain public until removed. To remove the six example stacks:

```sh
AWS_REGION=eu-central-1 bunx cdk destroy --all --profile jolo \
  --app 'bun run examples/benchmark/cdk-app.ts'
```

Review retained log groups, ECR images and S3 buckets separately; stack removal may not remove
all stored artifacts.

### oha benchmark (TypeScript/Bun orchestration)

Install `oha` (`brew install oha`), then run the focused concurrent I/O comparison:

```sh
bun run bench:run:oha --profile jolo --region eu-central-1
```

This runs all six deployed AWS servers at c=1,8,16,64, with two 30-second repeats
and a five-second warm-up before each cell. It uses HTTP/1.1 and leaves AWS settings
unchanged; account quotas can still constrain results. The wrapper is TypeScript,
uses the AWS CLI only for read-only configuration/CloudWatch queries, and invokes
`oha` for all measured load. It does not use the Python controller. To work around
oha's parsing of scoped IPv6 nameservers on macOS, Bun resolves IPv4 addresses and
passes them via `--connect-to`, retaining the original URL/Host/TLS verification.
DNS mappings are recorded; IPv6 and DNS resolver performance are outside this test.

Results are written incrementally to `examples/benchmark/OHA_RESULTS.md` and
`examples/benchmark/results/oha-aws-latest.json`. Each timestamped `results/oha-*/`
directory retains unmodified oha JSON, exact commands, warm-up runs, configuration
snapshots and CloudWatch diagnostics. Only 2xx responses count toward successful
throughput, regardless of oha's transport-level `successRate`.

The report embeds SVG throughput, cold-start and estimated monthly cost graphs.
Cold-start times come from the earlier verified AWS trials and are explicitly
separate from oha's warm I/O measurements. Costs compare 10M requests over 30 days
using Frankfurt rates retrieved from the AWS Price List API, with explicit Web
CPU/memory/residency and classic billed-duration assumptions—not WAN latency.

For the completed run, `cost-source.json` in its timestamped directory preserves
selected pricing products, the Cost Explorer query/response and the resource-level
reporting limitation. `cost-estimates.json` retains unrounded components and a
source checksum. Provisional account/service charges are **not** attributed to
individual functions or treated as evidence that the benchmark was free. Other
runs without matching cost evidence show costs as unavailable, not zero.

Regenerate the graphs, cold-start section and cost estimates from saved artifacts
without sending benchmark traffic or refreshing AWS billing data:

```sh
bun run bench:report:oha
```

### Framework-focused AWS-hosted comparison

```sh
bun run bench:run:framework --profile jolo --region eu-central-1
bun run bench:report:framework
```

This provisions a temporary four-core ARM `c7g.xlarge` in the existing default
VPC, controlled through SSM with no inbound ports. It runs separately bundled
node:http/Express/Hono/h3 minimal-response fixtures on one CPU, with oha on the
other three CPUs: five randomized 30-second repeats at c=1,16,64 after 15-second
warmups. Server CPU/request uses same-PID process counters. A second pass targets
the existing deployed `/ping` endpoints with a 1000 RPS ceiling; that pass measures
bounded-load latency, **not** maximum capacity or per-environment CPU efficiency.

Allow roughly 90 minutes of measurements, plus provisioning and collection.
On macOS the launcher holds a process-scoped idle-sleep assertion while it runs;
it does not modify global power preferences. Closing the lid or forcing sleep
can still interrupt local supervision. AWS-acknowledged SSM command IDs are
retained even if the local CLI times out after receiving its response.
Temporary EC2, EBS, IPv4 and Lambda request/compute charges apply. Results are
saved separately in `examples/benchmark/FRAMEWORK_RESULTS.md` and
`examples/benchmark/results/framework-*/`; the original I/O report is not replaced.
Raw output is checkpointed to a private encrypted S3 bucket. Normal completion
retrieves it before terminating the instance and destroying the runner stack.
A 115-minute guest shutdown/termination backstop limits a disconnected runner's
lifetime. Shared CDK bootstrap assets are not deleted.

If interrupted, consult that run's `recovery.json` for its SSM command, instance,
bucket and network IDs. Retrieve `s3://<bucket>/output/results.tar.gz` before cleanup.
Terminate the recorded instance if still running, then destroy only the dedicated
runner stack, supplying the recorded VPC/subnet IDs:

```sh
AWS_REGION=eu-central-1 bunx cdk destroy FrameworkBenchmarkRunner --profile jolo \
  --app 'bun run examples/benchmark/framework-cdk.ts' \
  --context vpcId=<recorded-vpc-id> --context subnetId=<recorded-subnet-id>
```

The offline report command verifies raw artifact hashes and does not provision
resources or generate traffic. Missing cleanup evidence is reported as unknown,
not silently assumed successful.

## Publishing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on pushes to `main` and can also be started manually. It uses the mise-pinned Node/Bun toolchain, installs the library and example dependencies from their frozen lockfiles, builds the JSII assembly, and runs runtime and compile-time tests. It publishes only when the version in `package.json` is not already on npm; existing versions are skipped, and registry errors fail the workflow rather than attempting a publish.

To release, bump `version` in `package.json`, update `bun.lock` with `bun install`, and merge into `main`. The workflow does not automatically bump versions or commit changes.

### One-time npm setup

In the [npm package settings](https://www.npmjs.com/package/lambda-web-function-construct/access), add a **GitHub Actions trusted publisher** with:

- **Organization or user:** `jolo-dev`
- **Repository:** `lambda-web-function-construct`
- **Workflow filename:** `publish.yml` (not its full path)
- **Environment name:** leave empty
- **Allowed actions:** enable direct publishing with `npm publish` if this option is shown

The workflow uses GitHub OIDC instead of an npm token secret. Bun handles installation, builds, and tests; the npm CLI bundled with Node 24 handles the final publish because npm trusted publishing requires it. Publications include provenance. Until the trusted publisher is configured, new-version publishes will fail authentication; unchanged versions still skip publishing. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).

## License

This library is licensed under the MIT License. See [LICENSE](LICENSE).
