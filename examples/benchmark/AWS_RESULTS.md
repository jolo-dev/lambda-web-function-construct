# AWS cloud vs. LocalStack benchmark

Run status: **complete** · Profile: `jolo` · Region: **eu-central-1**  
Started: 2026-11-01T14:43:30.782Z · Updated: 2026-11-01T15:05:30.885Z  
Load generator: **operator's darwin/arm64 machine, outside AWS**. Measured requests: **117,691**, errors: **6985**. Warm-up, telemetry and contract requests are additional.

> **Important correction to the earlier report:** LocalStack results do not establish an AWS-wide winner or production cost ranking. The old comparison used c=64 for Web Functions and c=8 for classic Event Lambda. This AWS run uses the same concurrency levels for every candidate. A classic Lambda's one-invocation-per-environment model does not imply low aggregate throughput: AWS scales it horizontally.

## Method and limitations

- **Capped warm run:** each Web Function endpoint temporarily uses maxEnvironments=8. The original settings are restored afterward. The uncapped attempt hit this account's **200 Arm-vCPU quota** and is preserved in `results/aws-uncapped-attempt.json`; throttling evidence is in `results/aws-quota-throttles.json`. This is a resource-bounded comparison, not an unrestricted AWS capacity ranking.
- Warm-up failures retained: **495**, by error type: {"Platform.EndpointMaxEnvThrottle":495}. These are separate from measured-cell errors. A high RPS with many 429s is **not** a successful low-error workload.
- Semantic correction: API Gateway ping/cold samples were rerun against /healthz after adding the alias. The original /ping samples returned AWS service-health text and are retained as discardedMeasurements, not included in summaries. Correction began 2026-11-01T15:03:22.044Z; all 36 server/scenario preflight response bodies were validated.
- Cold trial source: `examples/benchmark/results/aws-uncapped-attempt.json` (verified samples retained for the other five candidates from the preceding uncapped attempt; lambda-apigw uses the later /healthz correction artifact).
- Six deployed CDK stacks, Arm64, classic functions configured at 2,048 MB; Web Functions have the platform's fixed environment allocation. Equal memory configuration does **not** mean equal CPU allocation (classic Lambda CPU is proportional to memory).
- Six routes: ping, 1 KB JSON, 64 KB JSON, 30 ms async I/O, eight-chunk SSE (5 ms intervals), and 1,500 SHA-256 iterations.
- 2 repeats × 2000 ms per cell. Ping/I/O: c=1,8,16,64 for **every** candidate. Other routes: c=1,16. Server order reverses on repeat 2. Each cell attempts a pre-warm burst at the requested concurrency; retained warm-up failures mean not every slot is guaranteed warm.
- RPS = total successful requests / summed elapsed time. Displayed p50/p95/p99 are the median of the repeat-level percentiles, **not pooled percentiles**. Two brief repeats cannot establish statistical significance or tiny framework differences.
- AWS timings include WAN/TLS and service routing; LocalStack uses local HTTP. Do **not** interpret the AWS/LocalStack latency difference as pure server overhead, nor treat this as a saturation benchmark.
- Process CPU/RSS comes from **one sampled sandbox**. It is not aggregated across AWS environments and is not used to predict the bill. Web sandbox counts are distinct response logstreams per cell; they are observed lower bounds. Classic Lambda does not expose a sandbox ID in these examples, so its per-cell count is **unknown**, not 1.
- No 64-request cold burst was run. The previous claim that AWS would use exactly one Web Function environment for such a burst was an assumption, not a measurement. AWS dynamically sets concurrency and maintains headroom.
- The historical LocalStack run is preserved in `results/latest.json`; AWS data is separate in `results/aws-latest.json` and a timestamped artifact. AWS load is not mixed into the bare-process track.

## Measured AWS warm performance

| Server | Ping c=1 p50 ↓ ms | I/O c=8 RPS ↑ | I/O c=64 RPS ↑ | I/O c=64 p95 ↓ ms | I/O c=64 errors / attempts | Web sandboxes seen at c=64 (per repeat) |
| --- | --- | --- | --- | --- | --- | --- |
| node-http | 33.06 | 121.07 | 618.79 | 73.50 | 2451 / 5010 | 8, 8 |
| express | 32.75 | 117.95 | 695.53 | 100.17 | 1327 / 4199 | 8, 8 |
| hono | 32.92 | 124.52 | 767.46 | 94.56 | 1239 / 4401 | 9, 8 |
| h3 | 31.94 | 121.71 | 723.19 | 83.84 | 1626 / 4607 | 8, 8 |
| bun-http | 39.48 | 107.32 | 825.71 | 93.88 | 0 / 3410 | unknown, unknown |
| lambda-apigw | 45.91 | 105.21 | 828.71 | 90.31 | 0 / 3435 | unknown, unknown |


### Warm request latency
↓ Lower is better. Includes the operator-host → Frankfurt network round trip.

```text
node-http            ███████████████████████          33.06 ms
express              ███████████████████████          32.75 ms
hono                 ███████████████████████          32.92 ms
h3                   ██████████████████████           31.94 ms
bun-http             ████████████████████████████     39.48 ms
lambda-apigw         ████████████████████████████████ 45.91 ms
```

### Concurrent I/O throughput at c=64
↑ Higher is better. Same client concurrency (64), but AWS can use different numbers of environments.

```text
node-http            ████████████████████████         618.79 RPS
express              ███████████████████████████      695.53 RPS
hono                 ██████████████████████████████   767.46 RPS
h3                   ████████████████████████████     723.19 RPS
bun-http             ████████████████████████████████ 825.71 RPS
lambda-apigw         ████████████████████████████████ 828.71 RPS
```

### Scaling from c=1 to c=64
↑ Higher is better. Measured concurrency scaling; not a per-sandbox capacity estimate.

```text
node-http c=1        █                                15.17 RPS
express c=1          █                                15.54 RPS
hono c=1             █                                15.38 RPS
h3 c=1               █                                15.26 RPS
bun-http c=1         █                                13.62 RPS
lambda-apigw c=1     █                                13.82 RPS
node-http c=8        █████                            121.07 RPS
express c=8          █████                            117.95 RPS
hono c=8             █████                            124.52 RPS
h3 c=8               █████                            121.71 RPS
bun-http c=8         ████                             107.32 RPS
lambda-apigw c=8     ████                             105.21 RPS
node-http c=16       █████████                        239.15 RPS
express c=16         █████████                        237.94 RPS
hono c=16            █████████                        244.60 RPS
h3 c=16              █████████                        243.97 RPS
bun-http c=16        ████████                         219.18 RPS
lambda-apigw c=16    ████████                         214.90 RPS
node-http c=64       ████████████████████████         618.79 RPS
express c=64         ███████████████████████████      695.53 RPS
hono c=64            ██████████████████████████████   767.46 RPS
h3 c=64              ████████████████████████████     723.19 RPS
bun-http c=64        ████████████████████████████████ 825.71 RPS
lambda-apigw c=64    ████████████████████████████████ 828.71 RPS
```

### Tail latency at c=16
↓ Lower is better. Median of the two run-level p95 values, not a pooled percentile.

```text
node-http            ██████████████████████████       71.38 ms p95
express              █████████████████████████████    79.70 ms p95
hono                 ███████████████████████████      72.06 ms p95
h3                   ██████████████████████████       71.42 ms p95
bun-http             ████████████████████████████████ 86.60 ms p95
lambda-apigw         ██████████████████████████████   80.12 ms p95
```

### Streaming responsiveness
↓ Lower is better. Time until the first response chunk arrives, not the full response.

```text
node-http            ██████████████                   33.89 ms TTFB
express              ██████████████                   32.89 ms TTFB
hono                 █████████████                    32.70 ms TTFB
h3                   ██████████████                   33.11 ms TTFB
bun-http             ███████████████████████████████  74.70 ms TTFB
lambda-apigw         ████████████████████████████████ 77.87 ms TTFB
```


| Server | LocalStack TTFB / TTLB ↓ ms | AWS TTFB / TTLB ↓ ms | Interpretation |
| --- | --- | --- | --- |
| node-http | 1.53 / 37.84 | 33.89 / 68.94 | Native HTTP streaming; WAN may coalesce chunks |
| express | 1.62 / 41.20 | 32.89 / 67.51 | Native HTTP streaming; WAN may coalesce chunks |
| hono | 1.66 / 39.05 | 32.70 / 68.39 | Native HTTP streaming; WAN may coalesce chunks |
| h3 | 1.68 / 40.50 | 33.11 / 68.19 | Native HTTP streaming; WAN may coalesce chunks |
| bun-http | 51.98 / 51.99 | 74.70 / 74.73 | Buffered **by this implementation/configuration** |
| lambda-apigw | 52.07 / 52.07 | 77.87 / 77.88 | Buffered **by this implementation/configuration** |


The Bun bridge calls `upstreamRes.text()` and returns buffered JSON to the Runtime API; the API Gateway handler accumulates frames before returning. This is **not proof that every classic Lambda deployment must buffer**: Lambda Function URLs can be configured for response streaming with a streaming-capable runtime/adapter.

## Cold-start behaviour

↓ Lower is better. Three first-request measurements per candidate; see cold-start caveats below.

```text
node-http            ███████████████████████████      424.87 ms
express              ████████████████████████████████ 497.84 ms
hono                 █████████████████████████████    445.52 ms
h3                   █████████████████████████        386.86 ms
bun-http             ██████████████████████           340.15 ms
lambda-apigw         █████████████████                271.64 ms
```

| Server | AWS first-request trials ↓ ms | AWS median ↓ ms | LocalStack median ↓ ms | Old-revision responses excluded before valid trial |
| --- | --- | --- | --- | --- |
| node-http | 535.13, 424.87, 389.43 | 424.87 | 801.83 | 0 |
| express | 510.06, 486.93, 497.84 | 497.84 | 629.17 | 4 |
| hono | 489.43, 338.04, 445.52 | 445.52 | 712.63 | 2 |
| h3 | 469.57, 328.87, 386.86 | 386.86 | 724.73 | 3 |
| bun-http | 396.34, 300.64, 340.15 | 340.15 | 459.19 | 0 |
| lambda-apigw | 295.81, 271.64, 256.92 | 271.64 | 373.91 | 0 |


| Server | Matched AWS init durations ↓ ms | Matched AWS init CPU ↓ ms | Matched AWS init memory MB | Historical LocalStack init ↓ ms |
| --- | --- | --- | --- | --- |
| node-http | 239.00, 246.00, 197.00 | 138.00, 177.00, 137.00 | 139.00, 137.00, 137.00 | 9.00 |
| express | 238.00, 303.00, 297.00 | 179.00, 234.00, 234.00 | 149.00, 147.00, 151.00 | 30.00 |
| hono | 217.00, 190.00, 281.00 | 144.00, 142.00, 186.00 | 137.00, 138.00, 140.00 | 11.00 |
| h3 | 219.00, 198.00, 204.00 | 143.00, 143.00, 145.00 | 138.00, 139.00, 140.00 | 11.00 |
| bun-http | 93.71, 73.46, 57.68 | not measured, not measured, not measured | 37.00, 36.00, 37.00 | not measured |
| lambda-apigw | 122.73, 115.23, 91.33 | not measured, not measured, not measured | 81.00, 80.00, 79.00 | not measured |


The AWS init values above are matched to each trial's response logstream (Web) or Lambda request ID (classic REPORT line). They are actual platform initialization measurements, not framework-only startup times; missing CPU/init fields remain unmeasured. In particular, LocalStack's 9–30 ms init reports did **not** predict AWS's runtime initialization durations.

Each Web trial creates a fresh revision, waits for the control plane, then checks that the response's `lambda-web-logstream` contains the expected revision ID. Responses still routed to an old revision are retained in `propagationResponses` and excluded from the timing. Classic trials change a nonce while preserving other environment variables and wait for the Lambda update waiter.

These are **first-request-after-replacement** times, including transport overhead. They are not a complete distribution of naturally occurring AWS cold starts. Web Functions may create headroom ahead of demand. Three samples are too few to rank cold-start reliability. We do not subtract an arbitrary init time from end-to-end latency and label the remainder "container provisioning".

Distinct Web logstreams count environments visited over a cell, **not necessarily simultaneously active environments**. AWS's dynamic concurrency can remain below the configured maximum; limiting environments to 8 can cause EndpointMaxEnvThrottle errors before the platform adapts. Such errors are retained, not excluded from the report.

## Observed AWS vs. LocalStack differences

| Area | AWS cloud | LocalStack / implication |
| --- | --- | --- |
| Deployment | All six stacks deployed through CloudFormation in eu-central-1; container pushed to regional ECR | Local Docker and emulated CloudFormation in us-east-1; image build/pull and scheduling differ |
| CloudWatch Logs IAM | Initial deployment served HTTP but created no Web Function logs until execution roles received scoped logs:CreateLogGroup/CreateLogStream/PutLogEvents permissions | LocalStack had emitted init logs without these permissions, masking the missing execution-role policy. Fixed in src/web-function.ts |
| API Gateway /ping | Reserved root /ping returned Healthy Connection without invoking Lambda. Discarded those ping/cold observations; added /healthz and reran them with semantic validation | Historical LocalStack forwarded /ping to the handler. HTTP 200 alone was insufficient to validate parity |
| Revision rollout | Preflight observed old revision responses even after an update was reported successful; measured run verifies the response revision | LocalStack's near-immediate switch did not expose the same propagation hazard |
| Account quota | Actual applied Arm-vCPU quota: 200. Uncapped attempt recorded AccountActiveVCPUArm64Throttles; capped warm runs also retain EndpointMaxEnvThrottle warm-up/error observations | LocalStack's historical run did not enforce the same account-wide cloud quota |
| Scaling | Dynamic per-environment concurrency and proactive headroom; observed counts shown above, never assumed to equal one | Historical Web runs reported one sandbox at c=64. Classic containers competed for the same local machine; not a model of distributed AWS capacity |
| CPU/memory metrics | Non-empty AWS metric names: ExecutedRequests, EnvironmentCPUTime, EnvironmentMaxMemoryUsage, ResponseBytes, EnvironmentConcurrentRequests, EnvironmentActiveTime, HTTPResponseStatusClass4XX, EndpointActiveEnvironments, AccountActiveVCPUArm64Throttles, EndpointActiveEnvironmentThrottles, UrlRequestLatency, ConcurrentExecutions, Errors, Throttles, Invocations, UrlRequestCount, Duration | LocalStack omitted EnvironmentCPUTime and EnvironmentMaxMemoryUsage; process snapshots were a workaround, not billing data |
| Log delivery | 10 matching groups collected; telemetry can arrive asynchronously | LocalStack's local log availability is not a guarantee of immediate AWS centralized log delivery |
| Tooling | Installed AWS CLI 2.37.7 did not recognize lambda-web; current boto3 supports it and was used for control-plane actions | LocalStack's bundled boto3 already included the service model |
| Network | Public HTTPS from operator host to Frankfurt | Local HTTP to containers; timings are not directly equivalent |


### HTTP contract and rate-limit observations
| Probe | AWS immediate HTTP statuses (count) | AWS error type | Historical LocalStack status |
| --- | --- | --- | --- |
| unsupported-http-method | {"400":1} | Platform.MalformedRequest | 400 |
| header-sanitization-and-context | {"200":1} |  | 200 |
| endpoint-rate-limit-zero-disabled | {"200":1} |  | 503 |
| endpoint-request-rate-throttle | {"200":160} |  | 429 |


**Propagation-aware follow-up** (separate artifact results/aws-policy-propagation.json): disabling the endpoint was verified with statuses 503; re-enabling still returned 503, 503, 503, 503, 503, 503, 200 while the data plane converged. A subsequent bounded 1,000-request scheduled test recorded **{"200 (no error-type header)":245,"429 Platform.EndpointRequestThrottle":595,"503 (no error-type header)":160}**. The HTTP 503 responses without an error-type header are retained as unattributed service errors, not silently counted as successful requests or attributed to a guessed cause. Endpoint settings were restored again afterward. The initial 200/all-200 probe observations above were premature, not evidence that AWS ignores rate settings.

The rate burst is a bounded 160-request test, not a guaranteed sustained arrival rate of 100+ RPS. Zero throttles would not disprove enforcement. The historical max-environments=2/concurrency=2 probe was **not** repeated in this AWS run; no AWS parity claim is made for it. Original endpoint routing, scaling and throttling settings and classic environment variables are restored after the run. Restoration result: `{"restored":["node-http","express","hono","h3","bun-http","lambda-apigw"]}`.

A final independent read-back at 2026-11-01T15:12:02.283820+00:00 verified all original endpoint settings and classic environment variables. Removed 35 unrouted experimental Web revisions, retaining the four CloudFormation-managed revisions. Evidence and six stack statuses: results/aws-restoration-verification.json. The six deployed stacks themselves remain running.

## Cost corrections and Frankfurt rates

The previous illustrative ~$2.06/10M Web Function estimate used incorrect Web request/compute rates and assumed perfect packing with no memory residency between requests. **Do not use that estimate or the previous 7×–58× savings claims for AWS budgeting.**

Prices retrieved from the AWS Price List API for **eu-central-1**, stored in `results/aws-prices-eu-central-1.json` (USD on-demand, before discounts/free tier):

| Component | Verified rate |
| --- | --- |
| Web Function requests | $0.30 / million |
| Web active CPU | $0.0000349964 / vCPU-second |
| Web consumed memory | $0.0000046334 / GB-second while the environment runs, including between requests |
| Classic Event Lambda requests | $0.20 / million |
| Classic Arm compute, first tier | $0.0000133334 / allocated GB-second |
| HTTP API Gateway, first 300M requests | $1.20 / million requests; separate from Lambda |


**Example, not a measured bill:** 10M monthly requests, 1 ms active CPU/request, one Web environment resident for 30 days consuming 0.25 GB, versus a 2 GB classic function billed for 50 ms or 500 ms per request. The Web scenario costs **$6.35**; the classic compute+request scenarios cost **$15.33** and **$135.33**, **before API Gateway**. With **eight** such Web environments resident for the month, the same illustrative calculation becomes **$27.37**, even before background CPU/logging. If Web headroom creates more resident environments or memory/CPU is higher, its cost rises. If classic Lambda is right-sized below 2 GB, its cost falls. We have not measured those monthly assumptions.

### Illustrative monthly totals including API Gateway

The same assumptions above, now including HTTP API request charges where applicable. Web CPU and resident memory are held constant; classic durations are **billed function time**, not client WAN latency. These are modeled configurations, not measured framework-specific bills.

| Configuration | 10M requests / 30 days, USD ↓ |
| --- | --- |
| Web Functions: one resident environment × 0.25 GB, 1 ms active CPU/request | $6.35 |
| Web Functions: eight resident environments × 0.25 GB each, 1 ms active CPU/request | $27.37 |
| Bun + Function URL: 2 GB, 50 ms billed/request | $15.33 |
| Classic Lambda + HTTP API: 2 GB, 50 ms billed/request | $27.33 |
| Bun + Function URL: 2 GB, 500 ms billed/request | $135.33 |
| Classic Lambda + HTTP API: 2 GB, 500 ms billed/request | $147.33 |


The HTTP API fee alone is **$12.00 for 10M requests** in Frankfurt. Source: results/aws-prices-apigw-eu-central-1.json; calculation assumptions and breakdowns: results/aws-cost-scenarios.json. Function URLs have no additional gateway request fee; normal Lambda and data-transfer charges still apply. The four Web frameworks use the same pricing model, but their actual CPU/memory usage can differ; no measured cost ranking among them is established here.

This short run is not an invoice. CloudWatch is best-effort and billing data arrives later. ECR/S3 storage, CDK custom-resource Lambdas, log ingestion/storage, data transfer, taxes, discounts and free-tier usage are not included in the example. Initialization/background CPU beyond the assumed per-request CPU is also excluded. Do not infer costs from client WAN latency.

## Conclusion — when to use what

- **Hono / h3 on Web Functions:** good default candidates for Node.js HTTP apps needing routing, middleware, concurrent I/O and native streaming. Choose ecosystem and maintainability first; small framework differences in this WAN test are not conclusive.
- **node:http on Web Functions:** choose for very small services/proxies where avoiding dependencies outweighs writing routing/body handling yourself.
- **Express on Web Functions:** choose for existing Express apps; test your application's startup and middleware rather than assuming this tiny benchmark predicts it.
- **Classic Lambda + HTTP API Gateway:** choose when you want API Gateway HTTP API routing/JWT authorization or existing API contracts. Classic Lambda also supports non-HTTP triggers, but SQS/S3/etc. do **not** require an API Gateway. HTTP APIs do **not** provide usage plans/API keys; those require REST APIs. Horizontal scaling can deliver substantial aggregate throughput, so do not reject classic Lambda based on LocalStack's c=8 result.
- **Bun container + Function URL:** choose when Bun/native binaries/container packaging are requirements. This bridge is buffered and one-invocation-per-environment; that is a trade-off of the deployed example, not evidence Bun's HTTP engine is slow. Other supported languages may use managed runtimes or ZIP/custom runtimes; container images are not mandatory for every non-Node language.
- **For a production performance decision:** repeat with an AWS-hosted load generator in eu-central-1, longer runs, more repeats, comparable arrival rates, billed-duration/CPU/memory measurements, and realistic database dependencies. This run validates cloud behaviour and exposes emulator assumptions; it does not establish a universal best server.

## Full AWS results

| Server | Scenario | c | Repeats | Successful RPS ↑ | Run RPS range | Median run p50 ↓ ms | Median run p95 ↓ ms | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| node-http | ping | 1 | 2 | 28.80 | 28.20–29.40 | 33.06 | 43.16 | 0 |
| node-http | ping | 8 | 2 | 223.86 | 222.20–225.50 | 34.53 | 38.45 | 0 |
| node-http | ping | 16 | 2 | 451.82 | 445.90–457.70 | 34.37 | 40.39 | 0 |
| node-http | ping | 64 | 2 | 1538.84 | 1433.40–1644.90 | 36.53 | 61.03 | 150 |
| node-http | json-1kb | 1 | 2 | 28.15 | 27.80–28.50 | 33.81 | 46.16 | 0 |
| node-http | json-1kb | 16 | 2 | 399.27 | 389.70–408.90 | 36.08 | 68.11 | 0 |
| node-http | json-64kb | 1 | 2 | 18.30 | 18.30–18.30 | 53.83 | 59.99 | 0 |
| node-http | json-64kb | 16 | 2 | 110.99 | 106.50–115.50 | 99.34 | 346.44 | 0 |
| node-http | async-io-30ms | 1 | 2 | 15.17 | 14.90–15.40 | 64.06 | 82.40 | 0 |
| node-http | async-io-30ms | 8 | 2 | 121.07 | 119.40–122.80 | 64.80 | 73.52 | 0 |
| node-http | async-io-30ms | 16 | 2 | 239.15 | 239.10–239.20 | 65.42 | 71.38 | 0 |
| node-http | async-io-30ms | 64 | 2 | 618.79 | 556.30–681.30 | 65.90 | 73.50 | 2451 |
| node-http | stream-sse | 1 | 2 | 14.17 | 13.80–14.60 | 68.94 | 86.29 | 0 |
| node-http | stream-sse | 16 | 2 | 203.27 | 185.80–220.50 | 71.74 | 110.43 | 0 |
| node-http | compute-sha256 | 1 | 2 | 26.39 | 26.10–26.60 | 36.52 | 44.17 | 0 |
| node-http | compute-sha256 | 16 | 2 | 424.80 | 419.30–430.30 | 36.50 | 43.91 | 0 |
| express | ping | 1 | 2 | 28.48 | 27.00–30.00 | 32.75 | 52.75 | 0 |
| express | ping | 8 | 2 | 220.48 | 212.40–228.60 | 34.31 | 48.44 | 0 |
| express | ping | 16 | 2 | 443.59 | 443.50–443.70 | 34.42 | 41.55 | 0 |
| express | ping | 64 | 2 | 1654.91 | 1612.20–1697.30 | 35.31 | 53.34 | 40 |
| express | json-1kb | 1 | 2 | 26.83 | 25.80–27.90 | 33.11 | 70.70 | 0 |
| express | json-1kb | 16 | 2 | 390.23 | 381.20–399.30 | 35.64 | 70.06 | 0 |
| express | json-64kb | 1 | 2 | 15.83 | 13.50–18.20 | 54.08 | 98.50 | 0 |
| express | json-64kb | 16 | 2 | 96.20 | 78.20–119.10 | 104.52 | 342.78 | 0 |
| express | async-io-30ms | 1 | 2 | 15.54 | 15.50–15.60 | 63.27 | 73.44 | 0 |
| express | async-io-30ms | 8 | 2 | 117.95 | 113.40–122.50 | 64.22 | 78.78 | 0 |
| express | async-io-30ms | 16 | 2 | 237.94 | 235.20–240.70 | 64.20 | 79.70 | 0 |
| express | async-io-30ms | 64 | 2 | 695.53 | 690.80–700.20 | 67.00 | 100.17 | 1327 |
| express | stream-sse | 1 | 2 | 14.35 | 14.10–14.60 | 67.51 | 77.02 | 0 |
| express | stream-sse | 16 | 2 | 216.34 | 214.10–218.60 | 70.47 | 97.57 | 0 |
| express | compute-sha256 | 1 | 2 | 25.95 | 24.60–27.30 | 35.47 | 54.61 | 0 |
| express | compute-sha256 | 16 | 2 | 443.71 | 441.60–445.80 | 35.14 | 39.88 | 0 |
| hono | ping | 1 | 2 | 27.13 | 25.60–28.70 | 32.92 | 65.30 | 0 |
| hono | ping | 8 | 2 | 216.51 | 200.90–232.00 | 33.63 | 54.17 | 0 |
| hono | ping | 16 | 2 | 450.37 | 446.10–454.60 | 33.47 | 48.60 | 0 |
| hono | ping | 64 | 2 | 1562.24 | 1390.90–1734.60 | 35.16 | 71.79 | 97 |
| hono | json-1kb | 1 | 2 | 27.75 | 26.60–28.90 | 32.91 | 51.67 | 0 |
| hono | json-1kb | 16 | 2 | 449.78 | 447.60–452.00 | 34.33 | 41.02 | 0 |
| hono | json-64kb | 1 | 2 | 17.66 | 16.70–18.60 | 53.13 | 85.71 | 0 |
| hono | json-64kb | 16 | 2 | 103.16 | 99.40–107.20 | 99.29 | 365.77 | 0 |
| hono | async-io-30ms | 1 | 2 | 15.38 | 14.80–15.90 | 62.67 | 76.70 | 0 |
| hono | async-io-30ms | 8 | 2 | 124.52 | 123.30–125.80 | 63.44 | 67.82 | 0 |
| hono | async-io-30ms | 16 | 2 | 244.60 | 241.60–247.60 | 63.95 | 72.06 | 0 |
| hono | async-io-30ms | 64 | 2 | 767.46 | 715.00–819.90 | 65.09 | 94.56 | 1239 |
| hono | stream-sse | 1 | 2 | 14.47 | 14.00–15.00 | 68.39 | 74.26 | 0 |
| hono | stream-sse | 16 | 2 | 222.75 | 216.90–228.70 | 70.64 | 79.39 | 0 |
| hono | compute-sha256 | 1 | 2 | 23.82 | 22.00–25.70 | 36.55 | 65.67 | 0 |
| hono | compute-sha256 | 16 | 2 | 416.55 | 413.90–419.20 | 35.38 | 56.66 | 0 |
| h3 | ping | 1 | 2 | 29.89 | 29.60–30.20 | 31.94 | 38.66 | 0 |
| h3 | ping | 8 | 2 | 229.48 | 227.90–231.10 | 33.31 | 39.89 | 0 |
| h3 | ping | 16 | 2 | 414.75 | 377.30–453.20 | 33.88 | 70.79 | 0 |
| h3 | ping | 64 | 2 | 1664.29 | 1535.50–1793.50 | 34.86 | 58.07 | 55 |
| h3 | json-1kb | 1 | 2 | 28.54 | 28.10–29.00 | 33.50 | 42.98 | 0 |
| h3 | json-1kb | 16 | 2 | 427.51 | 411.90–443.10 | 34.95 | 54.52 | 0 |
| h3 | json-64kb | 1 | 2 | 17.39 | 16.60–18.20 | 53.46 | 100.73 | 0 |
| h3 | json-64kb | 16 | 2 | 99.67 | 95.70–103.80 | 102.58 | 370.45 | 0 |
| h3 | async-io-30ms | 1 | 2 | 15.26 | 15.20–15.30 | 63.41 | 85.93 | 0 |
| h3 | async-io-30ms | 8 | 2 | 121.71 | 121.30–122.10 | 63.71 | 80.66 | 0 |
| h3 | async-io-30ms | 16 | 2 | 243.97 | 240.50–247.40 | 63.94 | 71.42 | 0 |
| h3 | async-io-30ms | 64 | 2 | 723.19 | 569.30–877.10 | 64.87 | 83.84 | 1626 |
| h3 | stream-sse | 1 | 2 | 14.40 | 14.30–14.50 | 68.19 | 73.09 | 0 |
| h3 | stream-sse | 16 | 2 | 217.98 | 209.50–226.50 | 70.61 | 96.36 | 0 |
| h3 | compute-sha256 | 1 | 2 | 27.72 | 27.70–27.70 | 35.32 | 40.34 | 0 |
| h3 | compute-sha256 | 16 | 2 | 441.89 | 437.70–446.10 | 35.28 | 39.86 | 0 |
| bun-http | ping | 1 | 2 | 22.87 | 21.80–23.90 | 39.48 | 76.60 | 0 |
| bun-http | ping | 8 | 2 | 197.48 | 196.40–198.60 | 38.67 | 53.98 | 0 |
| bun-http | ping | 16 | 2 | 393.52 | 382.30–404.70 | 38.77 | 47.11 | 0 |
| bun-http | ping | 64 | 2 | 1468.88 | 1402.10–1537.00 | 40.81 | 60.16 | 0 |
| bun-http | json-1kb | 1 | 2 | 25.65 | 25.60–25.70 | 37.75 | 43.95 | 0 |
| bun-http | json-1kb | 16 | 2 | 347.76 | 340.70–355.00 | 40.66 | 77.35 | 0 |
| bun-http | json-64kb | 1 | 2 | 14.97 | 13.60–16.30 | 63.92 | 87.12 | 0 |
| bun-http | json-64kb | 16 | 2 | 91.32 | 89.00–93.60 | 111.12 | 377.73 | 0 |
| bun-http | async-io-30ms | 1 | 2 | 13.62 | 13.60–13.70 | 68.63 | 112.30 | 0 |
| bun-http | async-io-30ms | 8 | 2 | 107.32 | 101.80–112.80 | 69.86 | 97.85 | 0 |
| bun-http | async-io-30ms | 16 | 2 | 219.18 | 214.60–223.80 | 69.45 | 86.60 | 0 |
| bun-http | async-io-30ms | 64 | 2 | 825.71 | 777.40–873.90 | 71.15 | 93.88 | 0 |
| bun-http | stream-sse | 1 | 2 | 13.32 | 13.30–13.30 | 74.73 | 77.93 | 0 |
| bun-http | stream-sse | 16 | 2 | 203.55 | 202.20–204.90 | 76.29 | 89.19 | 0 |
| bun-http | compute-sha256 | 1 | 2 | 24.43 | 24.10–24.80 | 39.60 | 47.00 | 0 |
| bun-http | compute-sha256 | 16 | 2 | 388.97 | 383.10–394.80 | 39.74 | 46.34 | 0 |
| lambda-apigw | json-1kb | 1 | 2 | 22.72 | 21.70–23.80 | 43.22 | 48.43 | 0 |
| lambda-apigw | json-1kb | 16 | 2 | 357.55 | 351.80–363.30 | 43.69 | 51.34 | 0 |
| lambda-apigw | json-64kb | 1 | 2 | 14.62 | 14.50–14.70 | 66.21 | 88.65 | 0 |
| lambda-apigw | json-64kb | 16 | 2 | 103.82 | 96.80–111.30 | 107.34 | 322.05 | 0 |
| lambda-apigw | async-io-30ms | 1 | 2 | 13.82 | 13.70–13.90 | 72.08 | 79.11 | 0 |
| lambda-apigw | async-io-30ms | 8 | 2 | 105.21 | 102.70–107.70 | 72.79 | 99.73 | 0 |
| lambda-apigw | async-io-30ms | 16 | 2 | 214.90 | 212.70–217.10 | 72.70 | 80.12 | 0 |
| lambda-apigw | async-io-30ms | 64 | 2 | 828.71 | 818.80–838.60 | 74.45 | 90.31 | 0 |
| lambda-apigw | stream-sse | 1 | 2 | 12.32 | 12.30–12.30 | 77.88 | 108.75 | 0 |
| lambda-apigw | stream-sse | 16 | 2 | 192.94 | 191.30–194.60 | 79.02 | 102.25 | 0 |
| lambda-apigw | compute-sha256 | 1 | 2 | 21.52 | 20.90–22.10 | 44.06 | 62.95 | 0 |
| lambda-apigw | compute-sha256 | 16 | 2 | 326.58 | 309.30–344.10 | 45.30 | 73.54 | 0 |
| lambda-apigw | ping | 1 | 2 | 20.05 | 16.30–23.80 | 45.91 | 69.60 | 0 |
| lambda-apigw | ping | 8 | 2 | 178.22 | 168.50–188.10 | 43.28 | 57.10 | 0 |
| lambda-apigw | ping | 16 | 2 | 355.12 | 341.80–368.60 | 43.27 | 57.27 | 0 |
| lambda-apigw | ping | 64 | 2 | 1409.88 | 1393.80–1425.90 | 43.63 | 51.11 | 0 |


## Log collection

Collected 306 Web init-report events (centralized and .local copies may duplicate events) and 36772 classic REPORT lines. Full metric dimensions are retained in the JSON; raw messages, timestamps and streams are retained losslessly in the checksum-verified gzip archives referenced by telemetry.logArchive and supplementalTelemetry.logArchive. The metric/log windows cover the uncapped attempt, capped run and any correction windows; they are diagnostic evidence, not billing attribution to timed cells. Missing init logs are not replaced with invented values.

## Reproduce / clean up

```sh
python3 -m venv .venv-bench
.venv-bench/bin/pip install boto3
AWS_PROFILE=jolo AWS_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \
  bunx cdk synth --all --app 'bun run examples/benchmark/cdk-app.ts' --output cdk.out.aws
bunx cdk diff --all --app cdk.out.aws --profile jolo --no-change-set
bunx cdk deploy --all --app cdk.out.aws --profile jolo --require-approval never
BENCH_PYTHON=.venv-bench/bin/python bun run examples/benchmark/aws-run.ts --profile jolo --region eu-central-1
bun run examples/benchmark/aws-report.ts
# When finished with the public benchmark endpoints (not executed automatically):
bunx cdk destroy --all --app cdk.out.aws --profile jolo --force
```

On interruption, restore with `aws-control.py --profile jolo --region eu-central-1 restore < results/aws-snapshot-<run-id>.json` (use the correct snapshot). Never re-run LocalStack's `bench:deploy` command expecting it to target AWS.

Sources: [HTTP semantics](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-http.html), [scaling](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html), [monitoring and required logging permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring.html), [pricing and memory residency](https://aws.amazon.com/lambda/pricing/).
