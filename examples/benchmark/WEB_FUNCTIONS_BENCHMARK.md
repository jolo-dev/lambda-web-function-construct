# Web Functions Benchmark

Consolidated summary of the benchmark campaign conducted October 31–November 4, 2026: local processes, LocalStack, real AWS, oha concurrent I/O, controlled framework efficiency, cold starts, streaming, HTTP contracts, telemetry, and illustrative costs.

> **There is no single overall winner.** These experiments answer different questions. LocalStack validates development behavior; the longer AWS oha run compares deployed concurrent-I/O behavior; the controlled EC2 run compares framework/Node-adapter efficiency. Do not combine their throughput numbers into one ranking.

## Executive summary

- **Concurrent I/O on AWS:** the four Web Function implementations delivered **957–975 successful requests/sec** at c=64, versus **894** for the Bun container + Function URL and **853** for classic Lambda + HTTP API Gateway. All six had zero HTTP or transport failures in the longer oha run. Differences among the four Web frameworks were small and do not establish a framework winner.
- **Controlled framework efficiency:** on one ARM server CPU, node:http reached **40,986 RPS**, Hono **33,875**, Express **26,614**, and h3 **20,377** at c=64. Hono delivered about **27% more throughput and 21% less CPU/request than Express**, and led it in all 15 paired trials. This applies to the tested minimal implementations and adapters, not every application.
- **Deployed minimal-response latency:** from Frankfurt, all four Web Functions approached the intentional **1,000 RPS ceiling** at c=16/64. Corrected p95 latency was approximately **4.3–5.3 ms**. This is not their maximum capacity; some c=64 trials returned HTTP 429.
- **Streaming:** Web Functions delivered response chunks before completion on both LocalStack and AWS. The classic examples buffered because of their bridge/handler implementations—not because classic Lambda universally requires buffering.
- **Cold starts:** verified AWS replacement-first-request medians ranged from **272–498 ms**, but three samples per candidate are insufficient for a reliable cold-start ranking.
- **Costs:** estimates are sensitive to active CPU, consumed memory, environment residency, classic billed duration, and gateway charges. There is **no attributable measured bill or measured framework cost winner**.

## 1. Candidates and deployment models

| Candidate    | Runtime / HTTP implementation                         | Deployment                                  |
| ------------ | ----------------------------------------------------- | ------------------------------------------- |
| node-http    | Node.js 24, built-in node:http                        | Lambda Web Function                         |
| express      | Node.js 24, Express                                   | Lambda Web Function                         |
| hono         | Node.js 24, Hono with @hono/node-server               | Lambda Web Function                         |
| h3           | Node.js 24, h3 with its Node adapter                  | Lambda Web Function                         |
| bun-http     | Bun 1.4.4, Bun.serve with a custom Runtime API bridge | Classic ARM Lambda container + Function URL |
| lambda-apigw | Node.js 24, HTTP API event handler                    | Classic ARM Lambda ZIP + HTTP API Gateway   |

Classic functions were configured with 2,048 MB. Web Functions can serve concurrent requests within an environment; the classic examples process one invocation per environment and scale horizontally. Neither equal client concurrency nor similar memory configuration guarantees equal allocated compute.

The framework-focused controlled pass includes only the four Node implementations. It does **not** include Bun or API Gateway.

## 2. Experiment inventory — what each test establishes

Here **c** means client concurrency; in oha it is the connection count, with one in-flight request per connection. Higher successful RPS is better; lower latency, CPU/request, and errors are better for comparable workloads.

| Experiment | Generator and location | Coverage | Main limitation | Detailed evidence |
| --- | --- | --- | --- | --- |
| Bare-process baseline | Custom TypeScript/Bun fetch runner, operator's macOS ARM host | All six implementations without Lambda; ping, JSON, I/O, streaming, SHA-256 | Short runs; host/runtime/workload differ from controlled EC2 fixtures | [Local report](RESULTS.md), [data](results/latest.json) |
| LocalStack deployment | Same custom runner, local HTTP to LocalStack 2026.10.4 | Six stacks, warm/cold requests, telemetry, HTTP contracts | Web c=64 versus classic c=8 is **unequal load**, not an AWS capacity comparison | [Local report](RESULTS.md) |
| Initial real-AWS suite | Custom runner, operator host → eu-central-1 over HTTPS | 192 warm cells; six scenarios; two 2-second repeats; equal candidate concurrency | Temporary eight-environment Web cap caused substantial throttling | [AWS report](AWS_RESULTS.md), [data](results/aws-latest.json) |
| Longer AWS concurrent I/O | oha 1.16.0, operator host → Frankfurt | 48 measured cells: six candidates × c=1,8,16,64 × two 30-second repeats; 5-second warmups | WAN/TLS and 30 ms artificial I/O dominate; not maximum capacity | [oha report](OHA_RESULTS.md), [data](results/oha-aws-latest.json) |
| Controlled framework efficiency | oha on temporary Frankfurt c7g.xlarge; server CPU 3, generator CPUs 0–2 | 60 cells: four Node frameworks × c=1,16,64 × five randomized 30-second repeats; 15-second warmups | Minimal identical responses; one host and tested adapters, not full application workloads | [Framework report](FRAMEWORK_RESULTS.md), [data](results/framework-latest.json) |
| Frankfurt-origin deployed latency | Same EC2 generator → existing Web Function endpoints | Another 60 cells with the same repeats/concurrencies; 1,000 RPS schedule and latency correction | Bounded load, not capacity; corrected latency includes scheduling backlog | [Framework report](FRAMEWORK_RESULTS.md) |

The shared application suite covers `GET /ping`, header/context inspection, 1 KB and 64 KB JSON parsing/serialization, `GET /io?delayMs=30`, SSE streaming, and synchronous SHA-256 work. API Gateway uses a non-reserved health route (`/healthz`) for ping/cold validation because AWS intercepted root `/ping` with a service-health response.

## 3. Local processes and LocalStack

### Bare-process baseline

Historical operator-host results, without Lambda:

| Candidate | Ping c=64 successful RPS ↑ | 64 KB JSON c=16 successful RPS ↑ |
| --- | ---: | ---: |
| bun-http | 57,514.7 | 22,554.8 |
| node-http | 55,395.8 | 12,677.7 |
| hono | 55,110.8 | 12,741.1 |
| h3 | 53,403.7 | 12,694.0 |
| lambda-apigw, bare HTTP mode | 52,723.8 | 12,124.2 |
| express | 45,601.6 | 11,603.4 |

Bun led these local process measurements. That does not predict the deployed Bun container's ranking: its AWS path includes the custom invocation bridge and platform routing. These fixtures also differ from the later minimal-response EC2 test.

### LocalStack concurrent I/O

| Candidate | c | Successful RPS ↑ |
| --- | ---: | ---: |
| node-http | 64 | 898.3 |
| express | 64 | 570.7 |
| hono | 64 | 926.1 |
| h3 | 64 | 910.6 |
| bun-http | 8 | 148.5 |
| lambda-apigw | 8 | 114.6 |

The Web examples multiplexed requests within one observed sandbox; the classic examples used separate containers for concurrent invocations. **Do not rank deployment capacity from this table:** the load levels differ and all containers compete for the same local machine. LocalStack is useful for functional testing, not predicting AWS scaling, quotas, cold-start timing, or invoices.

## 4. Initial AWS suite — capped and throttled

The initial uncapped attempt encountered the account's **200 Arm-vCPU Web Function quota**. The subsequent suite temporarily capped each Web endpoint at eight environments and restored its configuration afterward. It retained **117,691 measured attempts, 6,985 measured errors**, plus **495 separate warmup failures**.

At c=64 with 30 ms I/O:

| Candidate | Successful RPS ↑ | Errors / attempts |
| --- | ---: | ---: |
| node-http | 618.79 | 2,451 / 5,010 |
| express | 695.53 | 1,327 / 4,199 |
| hono | 767.46 | 1,239 / 4,401 |
| h3 | 723.19 | 1,626 / 4,607 |
| bun-http | 825.71 | 0 / 3,410 |
| lambda-apigw | 828.71 | 0 / 3,435 |

The classic examples had higher successful throughput **under these imposed resource constraints**. This is not evidence of greater unconstrained runtime capacity. Keep this historical run separate from the longer no-artificial-cap oha run below.

## 5. Longer AWS oha concurrent-I/O comparison

All six candidates served `GET /io?delayMs=30`, with two 30-second repeats and 5-second warmups at each concurrency. This run introduced **no artificial environment cap**, preserved AWS settings, and recorded **471,455 measured requests with zero HTTP or transport failures**.

### Concurrency 64

| Candidate | Successful RPS ↑ | p50 ↓ ms | p95 ↓ ms |
| --- | ---: | ---: | ---: |
| h3 | 975.26 | 64.35 | 71.48 |
| express | 971.28 | 64.62 | 71.30 |
| node-http | 968.43 | 64.75 | 71.69 |
| hono | 957.27 | 64.82 | 72.82 |
| bun-http | 894.39 | 69.98 | 79.04 |
| lambda-apigw | 853.15 | 73.26 | 82.29 |

![AWS concurrent-I/O throughput at c=64; higher is better.](results/oha-2026-11-01T22-03-18-143Z/io-throughput-c64.svg)

The four Web implementations were close and outperformed these classic examples for this workload. Express's roughly 1.5% lead over Hono is **not a reliable framework ranking**: two repeats of a WAN test with 30 ms waiting do not isolate router overhead.

Whole-run one-minute CloudWatch diagnostics observed maxima of five active environments per Web candidate and 64 concurrent executions per classic candidate. These include warmups and cannot be attributed to individual cells. Actual account budgets differed: 200 Web Arm vCPUs versus 1,000 classic concurrent executions.

## 6. Controlled framework efficiency on Frankfurt EC2

A temporary non-burstable four-core ARM c7g.xlarge ran Node v24.22.2, Bun 1.4.4, and oha 1.16.0. Each fixture returned the same 11-byte JSON payload with the same configured headers, without artificial waiting. Server and generator had separate CPU affinity. Packages were Express 5.3.0, Hono 4.13.14, @hono/node-server 2.1.5, and h3 2.0.8.

### Concurrency 64, five randomized repeats

| Candidate | Successful RPS ↑ | p95 ↓ ms | Server CPU ms / 1,000 successes ↓ |
| --- | ---: | ---: | ---: |
| node-http | 40,985.97 | 1.75 | 24.36 |
| hono | 33,875.41 | 2.12 | 29.47 |
| express | 26,614.30 | 2.67 | 37.52 |
| h3 | 20,376.91 | 3.53 | 48.99 |

![Controlled minimal-response throughput at c=64; higher is better.](results/framework-2026-11-03T22-28-42-423Z/controlled-throughput.svg)

![Controlled process CPU per 1,000 successful requests at c=64; lower is better.](results/framework-2026-11-03T22-28-42-423Z/controlled-cpu.svg)

All 60 controlled cells had zero HTTP/transport failures and passed the basic generator-utilization check. CPU comes from monotonic same-PID `process.cpuUsage()` deltas, not an arbitrary sandbox sample. Generator aggregate utilization stayed well below the 85% flag threshold, although this alone cannot exclude every bottleneck.

**Interpretation:** node:http was the leanest tested implementation. Hono consistently outperformed Express in all 15 paired blocks across c=1,16,64; at c=64 it achieved approximately 27% higher throughput and 21% lower CPU/request. h3 was slower in these tested Node-adapter fixtures. These results do not establish performance for other runtimes, adapters, middleware stacks, or production applications.

## 7. Deployed Web Functions from the Frankfurt runner

This separate phase reused the existing Web Function `/ping` endpoints, without deployment changes, with a **1,000 RPS ceiling** and oha latency correction. Existing deployed response bodies were not the controlled fixture's identical minimal body.

### Concurrency 64, five repeats

| Candidate | Successful RPS, bounded | Corrected p50 ↓ ms | Corrected p95 ↓ ms | HTTP 429 |
| --- | ---: | ---: | ---: | ---: |
| node-http | 999.51 | 3.58 | 5.07 | 55 |
| hono | 999.78 | 3.76 | 5.03 | 12 |
| express | 999.82 | 3.78 | 5.29 | 0 |
| h3 | 999.26 | 3.77 | 5.27 | 91 |

At c=16, all four achieved approximately 1,000 RPS without measured errors, with corrected p95 values of 4.27–4.53 ms. Across the deployed phase there were **158 HTTP 429 responses and no transport errors**.

Reaching the ceiling does not establish equal maximum capacity. At c=1, achieved throughput was only about 284–305 RPS; latency-corrected percentiles included a growing backlog against the requested 1,000 RPS schedule. Those multi-second values are **not multi-second Lambda response times** and should not be compared directly with the uncorrected controlled-pass percentiles. Whole-window CloudWatch CPU diagnostics are not substituted for per-cell process CPU.

## 8. Streaming and cold-start behavior

### Streaming on real AWS

Historical WAN measurements at c=1; TTFB is time to first byte, TTLB is time to complete the response.

| Candidate | TTFB ↓ ms | TTLB ↓ ms | Observed behavior |
| --- | ---: | ---: | --- |
| node-http | 33.89 | 68.94 | Incremental streaming |
| express | 32.89 | 67.51 | Incremental streaming |
| hono | 32.70 | 68.39 | Incremental streaming |
| h3 | 33.11 | 68.19 | Incremental streaming |
| bun-http | 74.70 | 74.73 | Buffered by the custom bridge |
| lambda-apigw | 77.87 | 77.88 | Buffered by the handler |

LocalStack showed the same distinction: Web TTFB approximately 1.53–1.68 ms versus total stream time 37.84–41.20 ms; classic examples completed buffering before delivering the body. This is an implementation/configuration comparison. A streaming-capable classic runtime/adapter and endpoint configuration can behave differently.

### First request after replacement

| Candidate | LocalStack median ↓ ms | AWS median ↓ ms | Verified AWS trials |
| --- | ---: | ---: | ---: |
| node-http | 801.83 | 424.87 | 3 |
| express | 629.17 | 497.84 | 3 |
| hono | 712.63 | 445.52 | 3 |
| h3 | 724.73 | 386.86 | 3 |
| bun-http | 459.19 | 340.15 | 3 |
| lambda-apigw | 373.91 | 271.64 | 3 |

![Historical verified AWS replacement-first-request medians and individual trials; lower is better.](results/oha-2026-11-01T22-03-18-143Z/cold-start-times.svg)

These are identity-verified **replacement-first-request** observations, including network overhead—not natural cold-start distributions or framework-only initialization. They were collected in the earlier AWS suite, **not rerun by the warm oha or framework experiments**. No 64-request cold-burst experiment was performed.

AWS Web platform initialization samples were approximately 190–303 ms, versus LocalStack's 9–30 ms. Old-revision responses were excluded; classic samples had to identify a real Lambda invocation. Three trials cannot establish a reliable cold-start winner, and emulator initialization does not predict AWS initialization.

## 9. HTTP contracts, scaling, and emulator differences

| Check | LocalStack evidence | Real AWS evidence / lesson |
| --- | --- | --- |
| Unsupported TRACE | HTTP 400 | HTTP 400, `Platform.MalformedRequest` |
| Header/context handling | Context headers present; spoofed headers sanitized in the probe | Header/context probe returned 200; inspect raw evidence rather than infer every header behavior is identical |
| Endpoint disabled with rateLimit=0 | HTTP 503, `Platform.EndpointDisabled` | Verified after propagation; immediate control-plane success initially still yielded 200 |
| Request-rate throttling | HTTP 429 under a configured 100 RPS limit | Propagation-aware 1,000-request follow-up: 245 HTTP 200, 595 HTTP 429 `Platform.EndpointRequestThrottle`, 160 unattributed HTTP 503 |
| maxEnvironments=2, concurrency=2 probe | Two observed sandboxes and throttling | Exact probe not repeated on AWS; eight-environment suite separately exhibited environment-cap throttling |
| Revision changes | Near-immediate routing in historical tests | Successful endpoint update did not guarantee new-revision traffic; response identity must be checked |
| API Gateway root /ping | Forwarded to handler | AWS returned service-health text without invoking Lambda; invalid samples discarded and rerun against /healthz |
| CloudWatch Logs permissions | Logs emitted despite missing execution-role grants | Required scoped logging IAM permissions; construct corrected and redeployed |
| CPU/memory telemetry | Some platform CPU/memory metrics absent | AWS metrics/logs available, but can be delayed; missing series are not zero |

Observed sandbox count means distinct response logstreams visited over time, **not simultaneous active environments**. Classic sandbox counts remain unknown where no environment identity was supplied. One sampled process's CPU/RSS cannot represent an entire distributed function or an AWS bill.

## 10. Illustrative monthly costs — not measured bills

Public Frankfurt on-demand pricing evidence was retrieved November 2, 2026. These scenarios cover **10 million requests over 30 days**:

| Deployment assumption                         | 50 ms classic billed duration | 500 ms classic billed duration |
| --------------------------------------------- | ----------------------------: | -----------------------------: |
| Web: one continuously resident environment    |                         $6.35 |                          $6.35 |
| Web: eight continuously resident environments |                        $27.37 |                         $27.37 |
| Bun + Function URL, 2 GB ARM                  |                        $15.33 |                        $135.33 |
| Classic Lambda + HTTP API, 2 GB ARM           |                        $27.33 |                        $147.33 |

![Illustrative monthly deployment costs under explicit assumptions, not a measured cost ranking.](results/oha-2026-11-01T22-03-18-143Z/cost-estimates.svg)

- **Web assumptions:** 1 ms active CPU/request, 0.25 GB consumed memory/environment, and one or eight environments resident for the full month. Memory is billed during residency, **including idle intervals**. Longer classic durations here represent extra I/O waiting, not extra assumed Web CPU or residency.
- **Classic assumptions:** 2 GB ARM, billed duration of 50 or 500 ms/request. Client WAN latency is not billed function duration. HTTP API adds $12 per 10 million requests; Function URLs do not add that gateway fee.
- **Rates:** Web $0.30/million requests, $0.0000349964/active vCPU-second, $0.0000046334/consumed GB-second; classic $0.20/million requests and $0.0000133334/allocated ARM GB-second; HTTP API $1.20/million in the first tier.
- **Excluded:** free tier, discounts, credits, taxes, data transfer, logs, storage, and initialization/background CPU beyond the stated assumptions. Right-sizing classic memory or changing Web residency changes the comparison.
- **Actual billing unavailable:** the archived Cost Explorer query returned provisional $0 service rows without attributable Web/API Gateway usage, and resource-level reporting required payer opt-in. This does not prove the benchmark was free. Earlier approximately $2/10M and fixed 7×–58× savings claims were withdrawn.

See [the cost assumptions, formulas, and billing caveats](OHA_RESULTS.md#estimated-monthly-costs), [pricing/billing evidence](results/oha-2026-11-01T22-03-18-143Z/cost-source.json), and [machine-readable estimates](results/oha-2026-11-01T22-03-18-143Z/cost-estimates.json).

## 11. Measurement integrity and automated tests

The repository also has **50 automated tests** across 10 files, separate from the performance experiments. The suite, jsii build, and compile-time option checks passed during final campaign verification. Coverage includes:

- Construct option validation, resource wiring, logging IAM policy/dependencies, and synthesis of all six example stacks.
- Application response validation, rejection of API Gateway service-health text, and unknown-versus-observed sandbox accounting.
- HTTP 429/transport error accounting; only 2xx responses count as successful throughput. oha's `successRate=1` alone is insufficient.
- Throughput aggregation as summed successes / summed elapsed durations; latency summaries as medians of run-level percentiles, not pooled percentiles.
- Cold-revision identity, classic initialization-log parsing, and lossless checksum-verified compressed CloudWatch archives.
- Exact region/tier pricing selection, full-residency memory costs, gateway fees, invalid-assumption rejection, and report/graph provenance.
- Seeded randomized blocks, identical controlled payloads, same-PID monotonic CPU counters, separation of controlled/deployed results, and latency-correction caveats.
- Temporary runner safeguards: no inbound access, IMDSv2, encrypted disposable disk, shutdown backstop, valid bootstrap commands, and recovery of AWS-acknowledged SSM command IDs after local timeout.

The longer oha run retains 48 measured and 48 warmup raw artifacts; the framework run retains 120 measured and 120 warmup artifacts. Raw outputs, hashes, commands, versions, configuration snapshots, and cleanup evidence remain in their timestamped directories. Failed setup attempts are not counted as completed performance measurements.

## 12. Practical conclusions

| Requirement | Evidence-based choice |
| --- | --- |
| Minimal dependency footprint and low HTTP overhead | node:http was the leanest controlled implementation; expect to write more routing/body handling yourself |
| Lightweight Node routing with good tested efficiency | Hono was more efficient than Express in the controlled fixtures; validate real middleware and application behavior |
| Existing Express application | Web Functions can host it without rewriting to an event handler; weigh migration effort against measured application costs |
| h3 ecosystem | Choose for its APIs/integration where useful; do not assume its controlled Node-adapter throughput matched Hono in this campaign |
| Concurrent HTTP I/O and incremental streaming | Web Functions performed well for the tested workloads; validate actual quotas, headroom, and traffic patterns |
| Gateway-managed routing/JWT authorization or non-HTTP events | Classic Lambda remains appropriate; API Gateway is not required for non-HTTP triggers. HTTP API is not REST API usage plans/API keys |
| Bun/runtime/container requirements | Bun's bare engine was fast, but the tested classic bridge added different deployment behavior; optimize the whole path, not just the server |
| Production capacity or cost decision | Benchmark realistic routes/dependencies, arrival rates, application CPU/memory, billed durations, residency, and sustained scaling—not only minimal ping or WAN I/O |

The temporary framework EC2 instance, disk, dedicated artifact bucket, and runner stack were removed after result retrieval; deployed configuration was unchanged on read-back. The six shared public example stacks were **not** removed as part of that cleanup. Shared CDK bootstrap assets are also outside it. These are recorded campaign cleanup results, not a live inventory guarantee.

## Source reports and reproduction

- [Local processes and LocalStack](RESULTS.md)
- [Initial AWS suite, cloud/emulator differences, and corrections](AWS_RESULTS.md)
- [Longer oha I/O run, historical cold samples, and cost evidence](OHA_RESULTS.md)
- [Controlled framework and Frankfurt-origin deployed tests](FRAMEWORK_RESULTS.md)
- [Setup, execution, restoration, and cleanup instructions](../../README.md#web-functions-benchmark)

Offline report regeneration (does not generate benchmark traffic or refresh billing):

```sh
bun run bench:report
bun run bench:report:aws
bun run bench:report:oha
bun run bench:report:framework
```

This consolidated summary is curated from those reports; it is not overwritten by their regeneration commands. Executing new AWS benchmarks provisions or invokes billed resources—see the README before running them.
