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

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then use the pinned Node.js 24.22.1 and Bun 1.4.4 toolchain:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build
mise exec -- bun test
```

With mise activated in your shell, you can also run the Bun commands directly. Consumers require Node.js 24 or later; the mise pins select reproducible development versions.

CDK library, JSII, and JSII packaging versions are managed by `package.json` and `bun.lock`, not mise. The JSII tools use exact development dependency versions. The CDK CLI is a development dependency used to deploy the benchmark examples; it is not a runtime dependency of the construct.

`bun run build` invokes the local JSII compiler and emits the `.jsii` assembly used by Construct Hub to generate language-aware API documentation.

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

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on pushes to `main` and can also be started manually. It uses the mise-pinned Node/Bun toolchain, installs from the frozen lockfile, builds the JSII assembly, and runs runtime and compile-time tests. It publishes only when the version in `package.json` is not already on npm; existing versions are skipped, and registry errors fail the workflow rather than attempting a publish.

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
