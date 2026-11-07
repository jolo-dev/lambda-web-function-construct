# oha AWS benchmark results

Status: **complete** · Tool: **oha 1.16.0** · Profile: **jolo** · Region: **eu-central-1**

Started: 2026-11-07T15:12:22.232Z · Updated: 2026-11-07T15:42:13.767Z

## Method

- Six deployed servers; application responses validated before load, using /healthz for API Gateway rather than its reserved /ping.
- GET /io?delayMs=30; c=1,8,16,64; 2 repeats of 30 seconds, each preceded by 5 seconds of oha warm-up. Warm-ups are retained but excluded from measured totals.
- HTTP/1.1 with keep-alive, compression disabled, 15-second request timeout. Here c is simultaneous connections with one in-flight request each. Fixed-concurrency closed loop, not a fixed arrival-rate test; no coordinated-omission correction is claimed.
- macOS /etc/resolv.conf contains a scoped IPv6 nameserver that oha 1.16.0 cannot parse. The TypeScript wrapper resolves IPv4 addresses through the OS and supplies all returned addresses with --connect-to, sharing the same mapping between warm-up and measurement. Original URL/Host/TLS verification are preserved; no system DNS changes. Resolved addresses and timestamps are recorded per cell. oha may still emit its resolver-initialization warning in retained stderr. DNS resolver performance and IPv6 are not benchmarked.
- Only one candidate is loaded at a time. Candidate order and concurrency order reverse on the second repeat.
- The generator runs on the operator's darwin/arm64 host, not within AWS; results include WAN/TLS. This is not a maximum-capacity or per-vCPU efficiency test.
- **No AWS configuration changes**: unlike the earlier run, no artificial eight-environment cap is introduced. Actual applied limits are recorded below. Web account quota: **200 Arm vCPUs**; classic account concurrency quota: **1000**. These are different resource budgets, not unlimited or equal compute.
- Raw oha JSON is kept byte-for-byte. oha summary.successRate is a transport-completion measure and can be 100% despite HTTP 429; this summary counts **only HTTP 2xx** as API successes. HTTP failures and transport errors are retained separately.
- Throughput is summed 2xx responses / summed oha elapsed seconds, including request drain. Latencies are medians of repeat-level successful-response percentiles, not pooled percentiles.
- This focused run measures concurrent I/O only; it does not rerun CPU/JSON/streaming/cold-start cases or establish a cost winner.

## Actual configuration

| Candidate | Environment / reserved concurrency limit | Max requests per environment | Classic memory MB |
| --- | --- | --- | --- |
| node-http | not explicitly capped | 64 | platform fixed |
| express | not explicitly capped | 64 | platform fixed |
| hono | not explicitly capped | 64 | platform fixed |
| h3 | not explicitly capped | 64 | platform fixed |
| bun-http | not reserved/capped per function | 1 invocation | 2048 |
| lambda-apigw | not reserved/capped per function | 1 invocation | 2048 |

Configuration unchanged on before/after read-back: **true**. AWS snapshots and quotas are saved in the run directory.

## Results

Higher successful RPS is better; lower latency/error rate is better. **A throttled row is quota/scaling-constrained service behavior, not an unrestricted runtime limit.**

| Server | c | Repeats | Successful RPS ↑ | Run RPS range | Median run p50 ↓ ms | Median run p95 ↓ ms | HTTP failures | Transport errors | Failure rate ↓ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| node-http | 1 | 2 | 14.77 | 14.53–15.01 | 63.19 | 89.45 | 0 | 0 | 0.00% |
| express | 1 | 2 | 14.36 | 14.04–14.69 | 63.39 | 90.70 | 0 | 0 | 0.00% |
| hono | 1 | 2 | 14.33 | 14.19–14.47 | 63.58 | 93.31 | 0 | 0 | 0.00% |
| h3 | 1 | 2 | 14.53 | 14.06–15.01 | 63.36 | 92.51 | 0 | 0 | 0.00% |
| bun-http | 1 | 2 | 13.13 | 12.95–13.31 | 70.75 | 101.48 | 0 | 0 | 0.00% |
| lambda-apigw | 1 | 2 | 12.39 | 12.38–12.41 | 75.58 | 104.66 | 0 | 0 | 0.00% |
| node-http | 8 | 2 | 114.95 | 113.64–116.27 | 65.15 | 95.02 | 0 | 0 | 0.00% |
| express | 8 | 2 | 115.72 | 114.13–117.31 | 64.69 | 95.30 | 0 | 0 | 0.00% |
| hono | 8 | 2 | 115.69 | 113.60–117.78 | 64.95 | 88.70 | 0 | 0 | 0.00% |
| h3 | 8 | 2 | 114.34 | 111.38–117.30 | 64.62 | 96.13 | 0 | 0 | 0.00% |
| bun-http | 8 | 2 | 105.78 | 103.80–107.75 | 69.73 | 104.18 | 0 | 0 | 0.00% |
| lambda-apigw | 8 | 2 | 102.00 | 98.68–105.32 | 72.36 | 115.66 | 0 | 0 | 0.00% |
| node-http | 16 | 2 | 224.77 | 216.59–232.93 | 65.35 | 100.10 | 0 | 0 | 0.00% |
| express | 16 | 2 | 224.12 | 213.89–234.35 | 65.55 | 101.21 | 0 | 0 | 0.00% |
| hono | 16 | 2 | 232.51 | 232.18–232.85 | 64.59 | 84.58 | 0 | 0 | 0.00% |
| h3 | 16 | 2 | 235.78 | 233.41–238.16 | 64.24 | 80.81 | 0 | 0 | 0.00% |
| bun-http | 16 | 2 | 216.69 | 214.61–218.77 | 69.34 | 98.25 | 0 | 0 | 0.00% |
| lambda-apigw | 16 | 2 | 202.87 | 193.64–212.10 | 73.47 | 101.80 | 0 | 0 | 0.00% |
| node-http | 64 | 2 | 919.60 | 918.59–920.61 | 65.33 | 86.48 | 0 | 0 | 0.00% |
| express | 64 | 2 | 913.28 | 896.14–930.42 | 65.19 | 92.62 | 0 | 0 | 0.00% |
| hono | 64 | 2 | 929.63 | 920.77–938.48 | 65.27 | 86.51 | 0 | 0 | 0.00% |
| h3 | 64 | 2 | 909.14 | 899.80–918.47 | 65.54 | 91.26 | 0 | 0 | 0.00% |
| bun-http | 64 | 2 | 859.71 | 848.72–870.70 | 70.03 | 98.97 | 0 | 0 | 0.00% |
| lambda-apigw | 64 | 2 | 816.12 | 809.64–822.60 | 74.13 | 98.88 | 0 | 0 | 0.00% |

<!-- oha-visuals:start -->
### Concurrent I/O throughput at c=64

![Successful concurrent I/O throughput for the six candidates at c=64, in requests per second; higher is better.](results/oha-2026-11-07T15-12-22-232Z/io-throughput-c64.svg)

Only HTTP 2xx responses count. The graph summarizes the c=64 rows above, not per-environment capacity or a cost comparison.

## Cold-start times — earlier AWS trials

**Not measured by oha during this warm I/O run.** These are the earlier verified AWS first-request-after-replacement trials for the same profile and region. Web responses must match the replacement revision; classic responses must identify a Lambda invocation. Invalid service-health responses and stale Web revision responses are excluded.

| Server | Verified trials | First-request times ↓ ms | Median ↓ ms |
| --- | --- | --- | --- |
| node-http | 3 | 535.13, 424.87, 389.43 | 424.87 |
| express | 3 | 510.06, 486.93, 497.84 | 497.84 |
| hono | 3 | 489.43, 338.04, 445.52 | 445.52 |
| h3 | 3 | 469.57, 328.87, 386.86 | 386.86 |
| bun-http | 3 | 396.34, 300.64, 340.15 | 340.15 |
| lambda-apigw | 3 | 295.81, 271.64, 256.92 | 271.64 |

![Cold-start median first-request times in milliseconds; lower is better. Dots show the individual verified trials.](results/oha-2026-11-07T15-12-22-232Z/cold-start-times.svg)

These times include client/network overhead, not just platform or framework initialization. Web Functions may prepare environments before the first request. Three trials per candidate are too few to establish a reliable cold-start ranking or predict a simultaneous cold burst.

Provenance: [archived cold-start source](results/oha-2026-11-07T15-12-22-232Z/cold-start-source.json), extracted from [the earlier AWS dataset](results/aws-latest.json). Source dataset started 2026-11-01T14:43:30.782Z; its coldStartSource and correction metadata identify the earlier/replacement trials, including the API Gateway /healthz correction.

## Estimated monthly costs

No matching cost evidence was archived for this run. No actual benchmark charge or cost ranking can be inferred.

<!-- oha-visuals:end -->

## CloudWatch diagnostic evidence

| Candidate:metric | Query status | Points | Maximum environments/concurrency or summed throttle count |
| --- | --- | --- | --- |
| node-http:EndpointActiveEnvironments | Complete | 11 | 5.00 |
| node-http:AccountActiveVCPUArm64Throttles | Complete | 0 | not published |
| node-http:EndpointActiveEnvironmentThrottles | Complete | 0 | not published |
| express:EndpointActiveEnvironments | Complete | 12 | 5.00 |
| express:AccountActiveVCPUArm64Throttles | Complete | 0 | not published |
| express:EndpointActiveEnvironmentThrottles | Complete | 0 | not published |
| hono:EndpointActiveEnvironments | Complete | 14 | 6.00 |
| hono:AccountActiveVCPUArm64Throttles | Complete | 0 | not published |
| hono:EndpointActiveEnvironmentThrottles | Complete | 0 | not published |
| h3:EndpointActiveEnvironments | Complete | 15 | 5.00 |
| h3:AccountActiveVCPUArm64Throttles | Complete | 0 | not published |
| h3:EndpointActiveEnvironmentThrottles | Complete | 0 | not published |
| bun-http:ConcurrentExecutions | Complete | 14 | 64.00 |
| bun-http:Throttles | Complete | 14 | 0.00 |
| lambda-apigw:ConcurrentExecutions | Complete | 12 | 64.00 |
| lambda-apigw:Throttles | Complete | 12 | 0.00 |

CloudWatch uses one-minute aggregates over the whole run, includes warm-ups and possible unrelated traffic, and can arrive late. It is not per-cell attribution; an absent series is not proof of zero throttling.

## Artifacts and reproduction

- [Manifest with every exact command, timings, hashes and oha child resource usage](results/oha-2026-11-07T15-12-22-232Z/manifest.json)
- [Initial AWS configuration](results/oha-2026-11-07T15-12-22-232Z/configuration-before.json)
- [Final AWS configuration](results/oha-2026-11-07T15-12-22-232Z/configuration-after.json)
- Raw measured and warm-up JSON plus stderr files: results/oha-2026-11-07T15-12-22-232Z/
- Newest machine-readable index: results/oha-aws-latest.json

```sh
bun run bench:run:oha --profile jolo --region eu-central-1
```
