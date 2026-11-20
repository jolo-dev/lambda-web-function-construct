# Benchmark operations

How to run each benchmark experiment. Start with the
[Web Functions Benchmark](WEB_FUNCTIONS_BENCHMARK.md) for the consolidated results and
practical conclusions; each experiment remains separate so results from different
workloads and environments are never mistaken for one ranking.

Source reports:

- [RESULTS.md](RESULTS.md) — historical LocalStack report
- [AWS_RESULTS.md](AWS_RESULTS.md) — real AWS / LocalStack comparison with corrected Frankfurt pricing
- [OHA_RESULTS.md](AWS_RESULTS.md) — longer AWS oha concurrent-I/O runs
- [FRAMEWORK_RESULTS.md](FRAMEWORK_RESULTS.md) — controlled framework efficiency on Frankfurt EC2

All commands run from the repository root. LocalStack commands are `bench:deploy`,
`bench:run`, and `bench:report` (`package.json` scripts).

## Bare-process baseline

Runs the five local server processes — `node-http`, Express, Hono, h3, and Bun —
against the same workload suite without LocalStack, AWS, API Gateway, Docker, or AWS
credentials. The runner starts and stops each server itself and writes timestamped
JSON plus `results/bare-process-latest.json`. Results are host-specific and not
directly comparable to the Frankfurt EC2 or AWS endpoint results.

```sh
bun install --frozen-lockfile
bun run bench:run:bare
```

To drive the same five servers with [oha](https://github.com/hatoo/oha) instead of
the built-in runner (requires `oha` on PATH, e.g. `brew install oha`):

```sh
bun run bench:run:bare:oha
```

Same servers, workloads, and concurrency matrix, with a 2-second warm-up and a
5-second measured run per cell. Results go to
`results/bare-process-oha-latest.json` and a timestamped copy. Server CPU is not
sampled in this mode.

## Real AWS suite (public test endpoints; incurs charges)

```sh
python3 -m venv .venv-bench
.venv-bench/bin/pip install -r examples/benchmark/requirements-aws.txt
AWS_REGION=eu-central-1 bunx cdk diff --all --profile jolo \
  --app 'bun run examples/benchmark/cdk-app.ts' --no-change-set
AWS_REGION=eu-central-1 bun run bench:deploy:aws --profile jolo
BENCH_PYTHON=.venv-bench/bin/python bun run bench:run:aws --profile jolo --region eu-central-1
bun run bench:report:aws
```

Behavior and data handling:

- AWS raw data uses `results/aws-latest.json` plus timestamped checkpoints; it never
  overwrites LocalStack's `results/latest.json`.
- CloudWatch messages are preserved in checksum-verified `aws-cloudwatch-*.json.gz`
  archives.
- The runner uses equal concurrency levels, validates application response bodies,
  checks revision identity during cold trials, and temporarily caps each Web
  endpoint at eight environments (`--max-environments 2..16`).
- The API Gateway example uses `/healthz` because AWS intercepts root `/ping` with a
  service-health response.

Original configuration is restored on ordinary errors. After a process
interruption, restore the matching snapshot explicitly:

```sh
.venv-bench/bin/python examples/benchmark/aws-control.py --profile jolo --region eu-central-1 \
  restore < examples/benchmark/results/aws-snapshot-RUN_ID.json
```

Brief WAN measurements are not a substitute for a longer, co-located AWS capacity
or billing test. The deployed examples remain public until removed:

```sh
AWS_REGION=eu-central-1 bunx cdk destroy --all --profile jolo \
  --app 'bun run examples/benchmark/cdk-app.ts'
```

Review retained log groups, ECR images, and S3 buckets separately; stack removal may
not remove all stored artifacts.

## oha AWS comparison (TypeScript/Bun orchestration)

```sh
bun run bench:run:oha --profile jolo --region eu-central-1
```

Runs all six deployed AWS servers at c=1,8,16,64, with two 30-second repeats and a
five-second warm-up before each cell. Uses HTTP/1.1 and leaves AWS settings
unchanged; account quotas can still constrain results. The wrapper is TypeScript,
uses the AWS CLI only for read-only configuration/CloudWatch queries, and invokes
`oha` for all measured load — no Python controller. To work around oha's parsing of
scoped IPv6 nameservers on macOS, Bun resolves IPv4 addresses and passes them via
`--connect-to`, retaining the original URL/Host/TLS verification. DNS mappings are
recorded; IPv6 and DNS resolver performance are outside this test.

Data handling:

- Results are written incrementally to [OHA_RESULTS.md](OHA_RESULTS.md) and
  `results/oha-aws-latest.json`.
- Each timestamped `results/oha-*/` directory retains unmodified oha JSON, exact
  commands, warm-up runs, configuration snapshots, and CloudWatch diagnostics.
- Only 2xx responses count toward successful throughput, regardless of oha's
  transport-level `successRate`.

The report embeds SVG throughput, cold-start, and estimated monthly cost graphs.
Cold-start times come from the earlier verified AWS trials and are explicitly
separate from oha's warm I/O measurements. Costs compare 10M requests over 30 days
using Frankfurt rates retrieved from the AWS Price List API, with explicit Web
CPU/memory/residency and classic billed-duration assumptions — not WAN latency.

For the completed run, `cost-source.json` in its timestamped directory preserves
selected pricing products, the Cost Explorer query/response, and the
resource-level reporting limitation. `cost-estimates.json` retains unrounded
components and a source checksum. Provisional account/service charges are **not**
attributed to individual functions or treated as evidence that the benchmark was
free. Other runs without matching cost evidence show costs as unavailable, not zero.

Regenerate graphs, the cold-start section, and cost estimates from saved artifacts
without sending benchmark traffic or refreshing AWS billing data:

```sh
bun run bench:report:oha
```

## Framework comparison on a temporary EC2 runner

```sh
bun run bench:run:framework --profile jolo --region eu-central-1
bun run bench:report:framework
```

Provisions a temporary four-core ARM `c7g.xlarge` in the existing default VPC,
controlled through SSM with no inbound ports. It runs separately bundled
node:http/Express/Hono/h3 minimal-response fixtures on one CPU, with oha on the
other three CPUs: five randomized 30-second repeats at c=1,16,64 after 15-second
warmups. Server CPU/request uses same-PID process counters. A second pass targets
the existing deployed `/ping` endpoints with a 1000 RPS ceiling; that pass measures
bounded-load latency, **not** maximum capacity or per-environment CPU efficiency.

Practical notes:

- Allow roughly 90 minutes of measurements, plus provisioning and collection.
- On macOS the launcher holds a process-scoped idle-sleep assertion while it runs;
  it does not modify global power preferences. Closing the lid or forcing sleep can
  still interrupt local supervision. AWS-acknowledged SSM command IDs are retained
  even if the local CLI times out after receiving its response.
- Temporary EC2, EBS, IPv4, and Lambda request/compute charges apply.
- Results are saved separately in [FRAMEWORK_RESULTS.md](FRAMEWORK_RESULTS.md) and
  `results/framework-*/`; the original I/O report is not replaced.
- Raw output is checkpointed to a private encrypted S3 bucket. Normal completion
  retrieves it before terminating the instance and destroying the runner stack.
- A 115-minute guest shutdown/termination backstop limits a disconnected runner's
  lifetime. Shared CDK bootstrap assets are not deleted.

If interrupted, consult that run's `recovery.json` for its SSM command, instance,
bucket, and network IDs. Retrieve `s3://<bucket>/output/results.tar.gz` before
cleanup. Terminate the recorded instance if still running, then destroy only the
dedicated runner stack, supplying the recorded VPC/subnet IDs:

```sh
AWS_REGION=eu-central-1 bunx cdk destroy FrameworkBenchmarkRunner --profile jolo \
  --app 'bun run examples/benchmark/framework-cdk.ts' \
  --context vpcId=<recorded-vpc-id> --context subnetId=<recorded-subnet-id>
```

The offline report command verifies raw artifact hashes and does not provision
resources or generate traffic. Missing cleanup evidence is reported as unknown,
not silently assumed successful.
