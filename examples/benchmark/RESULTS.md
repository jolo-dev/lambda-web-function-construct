# LocalStack-only HTTP server benchmark

Generated: 2026-11-07T15:02:48.956Z · Host: darwin/arm64 · LocalStack: 2026.10.4 (Pro / Ultimate)

> **Historical emulator measurements, not an AWS performance ranking.** See [AWS_RESULTS.md](AWS_RESULTS.md) for the real AWS eu-central-1 run, equal-concurrency results, deployment differences and corrected pricing. Earlier claims of a universal winner and fixed cost savings were not supported by these LocalStack measurements.

## How to read this report

- **↑ Higher is better:** successful requests per second (RPS).
- **↓ Lower is better:** latency (p50 median, p95/p99 tail), time to first byte (TTFB), total response time (TTLB), bundle size and CPU per request for the same workload.
- These are short, single historical runs. Different concurrency, shared-host contention and emulator overhead prevent a fair cross-platform capacity ranking. Tiny timing differences are not statistically significant.
- Fewer sandboxes is not inherently better: additional environments provide additional CPU. A Web Function's configured concurrency is an upper bound, not a guarantee AWS uses exactly one sandbox at c=64.
- CPU and memory snapshots sample one sandbox, not the entire distributed function. They are not AWS billing measurements. Missing values are not fabricated.

## Graphs

### Concurrent I/O throughput

↑ Higher is better. Historical Web c=64 and classic c=8 runs use different concurrency; not an equal-load AWS comparison.

```text
node-http c=64          ████████████████████████████ 947.70 RPS
express c=64            ████████████████████████████ 946.70 RPS
hono c=64               ████████████████████████████ 952.40 RPS
h3 c=64                 ███████████████████████████  929.00 RPS
lambda-apigw c=8        ████                         119.50 RPS
bun-http c=8            ████                         140.30 RPS
```

### Warm ping latency

↓ Lower is better. Local HTTP client round trip at c=1; no Internet/TLS path.

```text
node-http               ████                         1.08 ms p50
express                 ████                         1.22 ms p50
hono                    ████                         1.19 ms p50
h3                      ████                         1.32 ms p50
lambda-apigw            ████████████████████████████ 8.42 ms p50
bun-http                ██████████████████████       6.54 ms p50
```

### Streaming first byte

↓ Lower is better. The Bun bridge and API Gateway handler buffer responses in these examples; this is not a universal classic Lambda limitation.

```text
node-http               █                            1.52 ms TTFB
express                 █                            1.71 ms TTFB
hono                    █                            1.72 ms TTFB
h3                      █                            1.86 ms TTFB
lambda-apigw            ████████████████████████████ 49.90 ms TTFB
bun-http                ███████████████████████████  47.33 ms TTFB
```

### First request after replacement

↓ Lower is better. Median of three LocalStack trials. Includes Docker/emulator startup; not a prediction of AWS cold-start latency.

```text
node-http               ███████████████████████████  770.10 ms
express                 ████████████████████████████ 805.95 ms
hono                    █████████████████████████    731.63 ms
h3                      ███████████████████████      662.56 ms
lambda-apigw            ██████████████████           518.23 ms
bun-http                ████████████████████         570.30 ms
```

### Recorded Web code initialization

↓ Lower is better. Actual platform.initReport samples only. These are separate observations, not subtractable phases of the median first-request timing.

```text
node-http               ████████                     9.00 ms init
express                 ████████████████████████████ 31.00 ms init
hono                    ██████████                   11.00 ms init
h3                      ███████████                  12.00 ms init
```

### Bare-process ping throughput

↑ Higher is better. c=64 on the operator host, without Lambda. This isolates a different execution path than deployed endpoints.

```text
node-http               ████████████████████         59970.30 RPS
express                 █████████████████            50390.70 RPS
hono                    ████████████████████         59575.70 RPS
h3                      █████████████████            51967.00 RPS
bun-http                ████████████████████████████ 84015.70 RPS
```


## Cold-start behaviour

| Server | Trial timings ↓ ms | Median ↓ ms | Warm ping p50 ↓ ms | Recorded init duration ↓ ms |
| --- | --- | --- | --- | --- |
| node-http | 664.37, 770.10, 781.11 | 770.10 | 1.08 | 9.00 |
| express | 805.95, 808.84, 651.22 | 805.95 | 1.22 | 31.00 |
| hono | 731.63, 702.35, 743.52 | 731.63 | 1.19 | 11.00 |
| h3 | 719.86, 652.16, 662.56 | 662.56 | 1.32 | 12.00 |
| lambda-apigw | 619.87, 518.23, 515.13 | 518.23 | 8.42 | not measured |
| bun-http | 530.06, 626.08, 570.30 | 570.30 | 6.54 | not measured |


Cold trials recycle a Web revision or classic function configuration. This is not a measured 64-request cold burst. LocalStack starts Docker containers; AWS uses its own environment lifecycle, dynamic concurrency and headroom. AWS rollout must also be checked at the data plane: a successful control-plane update can still be followed by an old-revision response. Do not infer a guaranteed number of AWS cold starts from this table.

## Packaging

| Server | Deployment | Bundle ↓ KB | ZIP ↓ KB / image MB |
| --- | --- | --- | --- |
| node-http | Lambda Web Function (nodejs24.x ZIP) | 6.86 | 2.43 KB ZIP |
| express | Lambda Web Function (nodejs24.x ZIP) | 863.76 | 253.84 KB ZIP |
| hono | Lambda Web Function (nodejs24.x ZIP) | 100.25 | 24.84 KB ZIP |
| h3 | Lambda Web Function (nodejs24.x ZIP) | 94.36 | 23.92 KB ZIP |
| lambda-apigw | Classic Event Lambda + HTTP API Gateway (nodejs24.x ZIP) | 11.03 | 3.53 KB ZIP |
| bun-http | Lambda Container Image (oven/bun:1.4.4-slim) | 6.93 | 201.8 MB image |


## Cost analysis

LocalStack does not simulate an AWS invoice. The earlier ~$2-per-10M Web Function estimate is withdrawn: it used incorrect rates and omitted memory residency between requests. Consult [the verified Frankfurt rates and explicit scenario assumptions](AWS_RESULTS.md#cost-corrections-and-frankfurt-rates).

Web Functions charge for requests, active CPU **and consumed memory for the time an environment runs**, including between requests. Classic Lambda charges for requests and allocated GB-seconds of invocation duration; API Gateway adds its own fee. Headroom, memory consumption, idle residency, memory right-sizing, logging, data transfer, discounts and free tier can change the result.

## Conclusion — when to use what

- **Hono / h3:** strong candidates for new Node.js HTTP apps where routing, middleware and concurrent streaming matter; choose the ecosystem you maintain best.
- **node:http:** minimal services/proxies with few routes and little need for a framework.
- **Express:** migration of an existing Express application; validate real middleware and dependencies.
- **Classic Lambda + HTTP API Gateway:** gateway-managed routing, JWT authorization and existing API contracts. Classic functions also support event sources without API Gateway. Usage plans/API keys belong to REST API, not HTTP API. AWS can scale classic Lambda horizontally; its LocalStack c=8 result is not a cloud throughput ceiling.
- **Bun container + Function URL:** when Bun or container packaging is required. This benchmark's custom bridge buffers responses. A different streaming-capable runtime/adapter and Function URL configuration can stream; other languages do not universally require container images.

## Full measurements

| Track | Server | Scenario | c | Successful RPS ↑ | p50 ↓ ms | p95 ↓ ms | p99 ↓ ms | TTFB / TTLB ↓ ms | Errors | Sandboxes observed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bare-process | node-http | ping | 1 | 19216.1 | 0.05 | 0.07 | 0.1 | — | 0 | 1 |
| bare-process | node-http | ping | 16 | 57724.5 | 0.28 | 0.46 | 0.58 | — | 0 | 1 |
| bare-process | node-http | ping | 64 | 59970.3 | 1.03 | 1.66 | 2.27 | — | 0 | 1 |
| bare-process | node-http | json-1kb | 1 | 16072.6 | 0.06 | 0.07 | 0.11 | — | 0 | 1 |
| bare-process | node-http | json-1kb | 16 | 44995.8 | 0.3 | 0.6 | 0.71 | — | 0 | 1 |
| bare-process | node-http | json-1kb | 64 | 44910 | 1.33 | 1.76 | 2.93 | — | 0 | 1 |
| bare-process | node-http | json-64kb | 1 | 8024.6 | 0.12 | 0.14 | 0.18 | — | 0 | 1 |
| bare-process | node-http | json-64kb | 16 | 12417.7 | 1.21 | 2.35 | 2.49 | — | 0 | 1 |
| bare-process | node-http | async-io-30ms | 1 | 31.4 | 31.95 | 32.48 | 32.78 | — | 0 | 1 |
| bare-process | node-http | async-io-30ms | 16 | 495.1 | 32.19 | 33.37 | 40.23 | — | 0 | 1 |
| bare-process | node-http | async-io-30ms | 64 | 2001.3 | 31.82 | 33.68 | 34.85 | — | 0 | 1 |
| bare-process | node-http | stream-sse | 1 | 23.9 | 41.36 | 47.48 | 51.29 | 0.67 / 41.36 | 0 | 1 |
| bare-process | node-http | stream-sse | 16 | 403.3 | 39.04 | 42.24 | 43.51 | 0.59 / 39.04 | 0 | 1 |
| bare-process | node-http | compute-sha256 | 1 | 1148.6 | 0.68 | 2.71 | 3.26 | — | 0 | 1 |
| bare-process | node-http | compute-sha256 | 16 | 1360.7 | 11.82 | 15.3 | 21.76 | — | 0 | 1 |
| bare-process | express | ping | 1 | 16970.6 | 0.06 | 0.07 | 0.12 | — | 0 | 1 |
| bare-process | express | ping | 16 | 51243.6 | 0.27 | 0.58 | 0.67 | — | 0 | 1 |
| bare-process | express | ping | 64 | 50390.7 | 1.15 | 1.72 | 2.82 | — | 0 | 1 |
| bare-process | express | json-1kb | 1 | 13892.6 | 0.07 | 0.09 | 0.12 | — | 0 | 1 |
| bare-process | express | json-1kb | 16 | 33848.5 | 0.42 | 0.83 | 0.95 | — | 0 | 1 |
| bare-process | express | json-1kb | 64 | 34021.7 | 1.83 | 2.13 | 3.67 | — | 0 | 1 |
| bare-process | express | json-64kb | 1 | 7450.9 | 0.13 | 0.15 | 0.2 | — | 0 | 1 |
| bare-process | express | json-64kb | 16 | 11606.7 | 1.28 | 2.52 | 2.66 | — | 0 | 1 |
| bare-process | express | async-io-30ms | 1 | 31.2 | 32.24 | 33.46 | 34.63 | — | 0 | 1 |
| bare-process | express | async-io-30ms | 16 | 488 | 32.75 | 33.91 | 35.36 | — | 0 | 1 |
| bare-process | express | async-io-30ms | 64 | 1977.8 | 32.3 | 33.88 | 34.33 | — | 0 | 1 |
| bare-process | express | stream-sse | 1 | 24.6 | 40.44 | 42.85 | 43.11 | 0.78 / 40.44 | 0 | 1 |
| bare-process | express | stream-sse | 16 | 406.2 | 39.21 | 41.25 | 43.15 | 0.64 / 39.21 | 0 | 1 |
| bare-process | express | compute-sha256 | 1 | 1211.1 | 0.69 | 2.74 | 3.04 | — | 0 | 1 |
| bare-process | express | compute-sha256 | 16 | 1352.1 | 11.92 | 21.04 | 23.65 | — | 0 | 1 |
| bare-process | hono | ping | 1 | 19333 | 0.05 | 0.06 | 0.11 | — | 0 | 1 |
| bare-process | hono | ping | 16 | 57382 | 0.28 | 0.47 | 0.54 | — | 0 | 1 |
| bare-process | hono | ping | 64 | 59575.7 | 1.09 | 1.61 | 2.21 | — | 0 | 1 |
| bare-process | hono | json-1kb | 1 | 15488.2 | 0.06 | 0.08 | 0.11 | — | 0 | 1 |
| bare-process | hono | json-1kb | 16 | 44184.2 | 0.32 | 0.63 | 0.75 | — | 0 | 1 |
| bare-process | hono | json-1kb | 64 | 43751.6 | 1.38 | 1.73 | 2.99 | — | 0 | 1 |
| bare-process | hono | json-64kb | 1 | 7821.9 | 0.12 | 0.14 | 0.17 | — | 0 | 1 |
| bare-process | hono | json-64kb | 16 | 12383.9 | 1.21 | 2.36 | 2.51 | — | 0 | 1 |
| bare-process | hono | async-io-30ms | 1 | 31.5 | 31.78 | 32.39 | 32.43 | — | 0 | 1 |
| bare-process | hono | async-io-30ms | 16 | 491.6 | 32.47 | 34.42 | 34.87 | — | 0 | 1 |
| bare-process | hono | async-io-30ms | 64 | 1964.6 | 32.35 | 34.69 | 38.64 | — | 0 | 1 |
| bare-process | hono | stream-sse | 1 | 22.8 | 43.13 | 49.86 | 51.93 | 1.15 / 43.13 | 0 | 1 |
| bare-process | hono | stream-sse | 16 | 406.2 | 38.97 | 41.61 | 43.22 | 0.87 / 38.97 | 0 | 1 |
| bare-process | hono | compute-sha256 | 1 | 1176.3 | 0.69 | 0.96 | 5.49 | — | 0 | 1 |
| bare-process | hono | compute-sha256 | 16 | 1341.6 | 9.32 | 18.48 | 24.83 | — | 0 | 1 |
| bare-process | h3 | ping | 1 | 17675.3 | 0.05 | 0.07 | 0.12 | — | 0 | 1 |
| bare-process | h3 | ping | 16 | 48834.5 | 0.3 | 0.57 | 1.03 | — | 0 | 1 |
| bare-process | h3 | ping | 64 | 51967 | 1.19 | 2.05 | 2.74 | — | 0 | 1 |
| bare-process | h3 | json-1kb | 1 | 15280.2 | 0.06 | 0.08 | 0.12 | — | 0 | 1 |
| bare-process | h3 | json-1kb | 16 | 40137 | 0.35 | 0.7 | 0.83 | — | 0 | 1 |
| bare-process | h3 | json-1kb | 64 | 39472.5 | 1.54 | 2.3 | 3.44 | — | 0 | 1 |
| bare-process | h3 | json-64kb | 1 | 7542.8 | 0.13 | 0.17 | 0.22 | — | 0 | 1 |
| bare-process | h3 | json-64kb | 16 | 12266.5 | 1.22 | 2.36 | 2.58 | — | 0 | 1 |
| bare-process | h3 | async-io-30ms | 1 | 31.4 | 31.92 | 32.49 | 34.74 | — | 0 | 1 |
| bare-process | h3 | async-io-30ms | 16 | 495.2 | 32.21 | 33.67 | 36.49 | — | 0 | 1 |
| bare-process | h3 | async-io-30ms | 64 | 1987.5 | 31.8 | 34.78 | 36.45 | — | 0 | 1 |
| bare-process | h3 | stream-sse | 1 | 24.7 | 40.88 | 42.33 | 42.73 | 0.98 / 40.88 | 0 | 1 |
| bare-process | h3 | stream-sse | 16 | 401.8 | 39.2 | 41.59 | 53.94 | 0.82 / 39.2 | 0 | 1 |
| bare-process | h3 | compute-sha256 | 1 | 1168 | 0.69 | 0.98 | 5.56 | — | 0 | 1 |
| bare-process | h3 | compute-sha256 | 16 | 1327.3 | 9.46 | 18.83 | 24.98 | — | 0 | 1 |
| bare-process | bun-http | ping | 1 | 21999.9 | 0.04 | 0.05 | 0.09 | — | 0 | 1 |
| bare-process | bun-http | ping | 16 | 76421.2 | 0.17 | 0.34 | 0.38 | — | 0 | 1 |
| bare-process | bun-http | ping | 64 | 84015.7 | 0.7 | 1.52 | 1.69 | — | 0 | 1 |
| bare-process | bun-http | json-1kb | 1 | 20350.8 | 0.05 | 0.06 | 0.08 | — | 0 | 1 |
| bare-process | bun-http | json-1kb | 16 | 64351.4 | 0.23 | 0.43 | 0.51 | — | 0 | 1 |
| bare-process | bun-http | json-1kb | 64 | 69446.3 | 0.79 | 1.55 | 2.1 | — | 0 | 1 |
| bare-process | bun-http | json-64kb | 1 | 10621.1 | 0.09 | 0.11 | 0.23 | — | 0 | 1 |
| bare-process | bun-http | json-64kb | 16 | 22270.6 | 0.6 | 1.22 | 1.54 | — | 0 | 1 |
| bare-process | bun-http | async-io-30ms | 1 | 31.6 | 31.68 | 32.55 | 32.6 | — | 0 | 1 |
| bare-process | bun-http | async-io-30ms | 16 | 502.3 | 31.83 | 32.57 | 32.75 | — | 0 | 1 |
| bare-process | bun-http | async-io-30ms | 64 | 2000.1 | 31.91 | 33.36 | 35.61 | — | 0 | 1 |
| bare-process | bun-http | stream-sse | 1 | 25 | 40.06 | 41.03 | 41.91 | 0.49 / 40.06 | 0 | 1 |
| bare-process | bun-http | stream-sse | 16 | 401.5 | 39.75 | 40.83 | 42.57 | 0.9 / 39.75 | 0 | 1 |
| bare-process | bun-http | compute-sha256 | 1 | 1476.5 | 0.54 | 1.6 | 1.78 | — | 0 | 1 |
| bare-process | bun-http | compute-sha256 | 16 | 1771.3 | 8.54 | 16.11 | 18.08 | — | 0 | 1 |
| localstack-lambda | node-http | ping | 1 | 864.4 | 1.08 | 1.62 | 2.6 | — | 0 | 1 |
| localstack-lambda | node-http | ping | 16 | 921.4 | 17.05 | 25.16 | 37.37 | — | 0 | 1 |
| localstack-lambda | node-http | ping | 64 | 960.4 | 62.11 | 97.14 | 118.19 | — | 0 | 1 |
| localstack-lambda | node-http | json-1kb | 1 | 690.7 | 1.35 | 2.03 | 3.33 | — | 0 | 1 |
| localstack-lambda | node-http | json-1kb | 16 | 824.2 | 18.82 | 28.91 | 52.99 | — | 0 | 1 |
| localstack-lambda | node-http | json-1kb | 64 | 871.2 | 69.23 | 107.01 | 117.89 | — | 0 | 1 |
| localstack-lambda | node-http | json-64kb | 1 | 546.4 | 1.62 | 2.84 | 4.64 | — | 0 | 1 |
| localstack-lambda | node-http | json-64kb | 16 | 774.2 | 21.54 | 29.15 | 33.33 | — | 0 | 1 |
| localstack-lambda | node-http | async-io-30ms | 1 | 30.3 | 32.28 | 37.43 | 37.89 | — | 0 | 1 |
| localstack-lambda | node-http | async-io-30ms | 16 | 232.1 | 35.12 | 644.81 | 675.34 | — | 0 | 1 |
| localstack-lambda | node-http | async-io-30ms | 64 | 947.7 | 66.35 | 78.8 | 99.44 | — | 0 | 1 |
| localstack-lambda | node-http | stream-sse | 1 | 23.7 | 42.21 | 45.05 | 47.22 | 1.52 / 42.21 | 0 | 1 |
| localstack-lambda | node-http | stream-sse | 16 | 378 | 40.06 | 51.4 | 62.24 | 3.47 / 40.06 | 0 | 1 |
| localstack-lambda | node-http | compute-sha256 | 1 | 359.4 | 2.11 | 3.08 | 7.13 | — | 0 | 1 |
| localstack-lambda | node-http | compute-sha256 | 16 | 649.3 | 18.68 | 30.12 | 161.73 | — | 0 | 1 |
| localstack-lambda | express | ping | 1 | 760.5 | 1.22 | 1.69 | 2.57 | — | 0 | 1 |
| localstack-lambda | express | ping | 16 | 955.9 | 16.68 | 23.44 | 28.05 | — | 0 | 1 |
| localstack-lambda | express | ping | 64 | 973.4 | 61.28 | 95.88 | 128.08 | — | 0 | 1 |
| localstack-lambda | express | json-1kb | 1 | 695.7 | 1.34 | 1.77 | 2.84 | — | 0 | 1 |
| localstack-lambda | express | json-1kb | 16 | 852.1 | 18.74 | 26.44 | 30.85 | — | 0 | 1 |
| localstack-lambda | express | json-1kb | 64 | 868.7 | 68.04 | 106.85 | 114.33 | — | 0 | 1 |
| localstack-lambda | express | json-64kb | 1 | 586.1 | 1.57 | 2.38 | 3.45 | — | 0 | 1 |
| localstack-lambda | express | json-64kb | 16 | 763.8 | 21.83 | 29.13 | 32.25 | — | 0 | 1 |
| localstack-lambda | express | async-io-30ms | 1 | 29.4 | 33.23 | 39.58 | 46.39 | — | 0 | 1 |
| localstack-lambda | express | async-io-30ms | 16 | 455 | 33.75 | 43.65 | 53.21 | — | 0 | 1 |
| localstack-lambda | express | async-io-30ms | 64 | 946.7 | 65.84 | 78.44 | 95.08 | — | 0 | 1 |
| localstack-lambda | express | stream-sse | 1 | 16.3 | 42.54 | 408.23 | 408.23 | 1.71 / 42.54 | 0 | 1 |
| localstack-lambda | express | stream-sse | 16 | 373.4 | 40.53 | 58.7 | 66.76 | 3.93 / 40.53 | 0 | 1 |
| localstack-lambda | express | compute-sha256 | 1 | 379.9 | 2.09 | 3.07 | 19.02 | — | 0 | 1 |
| localstack-lambda | express | compute-sha256 | 16 | 624.5 | 19 | 72.97 | 83.34 | — | 0 | 1 |
| localstack-lambda | hono | ping | 1 | 802.2 | 1.19 | 1.62 | 2.35 | — | 0 | 1 |
| localstack-lambda | hono | ping | 16 | 926.9 | 16.69 | 25.67 | 38.79 | — | 0 | 1 |
| localstack-lambda | hono | ping | 64 | 989.4 | 59.38 | 94.45 | 109.88 | — | 0 | 1 |
| localstack-lambda | hono | json-1kb | 1 | 705.4 | 1.3 | 1.84 | 2.8 | — | 0 | 1 |
| localstack-lambda | hono | json-1kb | 16 | 865.1 | 18.49 | 25.88 | 30 | — | 0 | 1 |
| localstack-lambda | hono | json-1kb | 64 | 885.5 | 67.65 | 103.46 | 115.02 | — | 0 | 1 |
| localstack-lambda | hono | json-64kb | 1 | 594.9 | 1.54 | 2.49 | 4.57 | — | 0 | 1 |
| localstack-lambda | hono | json-64kb | 16 | 791.5 | 21.17 | 28.1 | 31.48 | — | 0 | 1 |
| localstack-lambda | hono | async-io-30ms | 1 | 30.6 | 32.03 | 35.64 | 35.95 | — | 0 | 1 |
| localstack-lambda | hono | async-io-30ms | 16 | 467 | 32.88 | 38.01 | 59.67 | — | 0 | 1 |
| localstack-lambda | hono | async-io-30ms | 64 | 952.4 | 64.51 | 84.54 | 103.19 | — | 0 | 1 |
| localstack-lambda | hono | stream-sse | 1 | 22.8 | 43.27 | 50.52 | 56.61 | 1.72 / 43.27 | 0 | 1 |
| localstack-lambda | hono | stream-sse | 16 | 382.9 | 40.66 | 46.18 | 53.48 | 3.69 / 40.66 | 0 | 1 |
| localstack-lambda | hono | compute-sha256 | 1 | 325.5 | 2.37 | 3.9 | 34.94 | — | 0 | 1 |
| localstack-lambda | hono | compute-sha256 | 16 | 615.5 | 20.13 | 75.52 | 83.92 | — | 0 | 1 |
| localstack-lambda | h3 | ping | 1 | 622.9 | 1.32 | 2.81 | 7.43 | — | 0 | 1 |
| localstack-lambda | h3 | ping | 16 | 530.6 | 17.58 | 43.04 | 484.78 | — | 0 | 1 |
| localstack-lambda | h3 | ping | 64 | 950.1 | 66.11 | 100.62 | 119.82 | — | 0 | 1 |
| localstack-lambda | h3 | json-1kb | 1 | 691.6 | 1.34 | 1.76 | 3.02 | — | 0 | 1 |
| localstack-lambda | h3 | json-1kb | 16 | 841.1 | 18.91 | 26.88 | 30.9 | — | 0 | 1 |
| localstack-lambda | h3 | json-1kb | 64 | 853.2 | 68.94 | 108.1 | 122.62 | — | 0 | 1 |
| localstack-lambda | h3 | json-64kb | 1 | 569.6 | 1.61 | 2.64 | 4.86 | — | 0 | 1 |
| localstack-lambda | h3 | json-64kb | 16 | 769.9 | 21.89 | 29.07 | 34.37 | — | 0 | 1 |
| localstack-lambda | h3 | async-io-30ms | 1 | 29.7 | 32.33 | 36.94 | 46.71 | — | 0 | 1 |
| localstack-lambda | h3 | async-io-30ms | 16 | 455.6 | 33.88 | 39.59 | 46.27 | — | 0 | 1 |
| localstack-lambda | h3 | async-io-30ms | 64 | 929 | 67.51 | 83.04 | 98.4 | — | 0 | 1 |
| localstack-lambda | h3 | stream-sse | 1 | 23.3 | 42.96 | 46.93 | 54.03 | 1.86 / 42.96 | 0 | 1 |
| localstack-lambda | h3 | stream-sse | 16 | 380.6 | 39.91 | 52.42 | 65.18 | 3.38 / 39.91 | 0 | 1 |
| localstack-lambda | h3 | compute-sha256 | 1 | 392 | 2.1 | 3.07 | 4.89 | — | 0 | 1 |
| localstack-lambda | h3 | compute-sha256 | 16 | 608.9 | 20.28 | 74.36 | 80.13 | — | 0 | 1 |
| localstack-lambda | lambda-apigw | ping | 1 | 115.6 | 8.42 | 10.78 | 11.76 | — | 0 | 1 |
| localstack-lambda | lambda-apigw | ping | 8 | 90.2 | 53.34 | 70.96 | 87.48 | — | 0 | 8 |
| localstack-lambda | lambda-apigw | json-1kb | 1 | 110.5 | 8.76 | 10.75 | 20.08 | — | 0 | 1 |
| localstack-lambda | lambda-apigw | json-64kb | 1 | 104.5 | 9.5 | 11.12 | 12.22 | — | 0 | 1 |
| localstack-lambda | lambda-apigw | async-io-30ms | 1 | 23.8 | 39.86 | 56.21 | 56.22 | — | 0 | 1 |
| localstack-lambda | lambda-apigw | async-io-30ms | 8 | 119.5 | 63.59 | 85.95 | 111.46 | — | 0 | 8 |
| localstack-lambda | lambda-apigw | stream-sse | 1 | 20 | 49.95 | 53.73 | 56.1 | 49.9 / 49.95 | 0 | 1 |
| localstack-lambda | lambda-apigw | compute-sha256 | 1 | 101.2 | 9.78 | 11.72 | 12.48 | — | 0 | 1 |
| localstack-lambda | bun-http | ping | 1 | 151.8 | 6.54 | 8.43 | 9.18 | — | 0 | 1 |
| localstack-lambda | bun-http | ping | 8 | 123 | 41.09 | 76.05 | 571.98 | — | 0 | 8 |
| localstack-lambda | bun-http | json-1kb | 1 | 120.3 | 7.13 | 15.31 | 32.33 | — | 0 | 1 |
| localstack-lambda | bun-http | json-64kb | 1 | 129.2 | 7.57 | 9.73 | 10.55 | — | 0 | 1 |
| localstack-lambda | bun-http | async-io-30ms | 1 | 26 | 37.9 | 43.63 | 47.07 | — | 0 | 1 |
| localstack-lambda | bun-http | async-io-30ms | 8 | 140.3 | 53.25 | 77.87 | 91.36 | — | 0 | 8 |
| localstack-lambda | bun-http | stream-sse | 1 | 21.1 | 47.33 | 51.5 | 53.17 | 47.33 / 47.33 | 0 | 1 |
| localstack-lambda | bun-http | compute-sha256 | 1 | 124 | 7.82 | 10.8 | 12.97 | — | 0 | 1 |


## Historical contract probes

| Probe | Passed | HTTP | Error type |
| --- | --- | --- | --- |
| unsupported-http-method | true | 400 | Platform.MalformedRequest |
| header-sanitization-and-context | true | 200 | — |
| endpoint-rate-limit-zero-disabled | true | 503 | Platform.EndpointDisabled |
| endpoint-request-rate-throttle | true | 429 | Platform.EndpointRequestThrottle |
| endpoint-max-env-scale-and-throttle | true | 429 | Platform.EndpointMaxEnvThrottle |

