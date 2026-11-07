# Framework-focused AWS-hosted benchmark

Status: **complete** · Profile: **jolo** · Region: **eu-central-1** · Started: 2026-11-03T22:28:42.423Z

## What this experiment can tell us

This separates framework/Node-adapter efficiency from Lambda endpoint and WAN effects. It does not overwrite the earlier 30ms-I/O oha benchmark. Controlled throughput, CPU efficiency and deployed endpoint latency answer different questions; do not compare absolute RPS across the two passes as though they were the same environment.

## Method and provenance

- Temporary non-burstable **c7g.xlarge**, Linux ARM64, Frankfurt. Server pinned to CPU **3**; oha pinned to CPUs **0–2**. Affinity separates the benchmark processes, not all kernel/SSM background activity.
- Controlled fixtures are separately bundled with the same dependency versions; only the selected framework is loaded in each server process. Each returns the same 11-byte JSON body and configured headers, without artificial I/O or per-request telemetry sampling. Hono uses @hono/node-server; h3 uses its Node adapter. This tests those implementations, not every possible adapter/runtime.
- One fresh Node server per controlled trial; 15s warmup then 30s measurement. **5 randomized repeats** at c=1,16,64, grouped into same-concurrency four-framework blocks. Seed **2582753803** is saved for reproducibility.
- CPU is the delta of **process.cpuUsage()** from the same server PID around the measured interval, divided by successful requests. It includes the whole Node server process and small telemetry boundary overhead, not an isolated router function. Peak RSS in raw snapshots covers the process lifetime, including startup/warmup.
- Generator CPU usage uses Bun's microsecond counters divided by wall time and three available generator cores. Controlled cells at >=85% aggregate generator CPU, or with HTTP/transport failures, are flagged rather than treated as clean unconstrained samples. Aggregate utilization is a diagnostic, not proof that no single-thread or network bottleneck exists.
- Deployed pass targets existing HTTPS /ping routes from the same Frankfurt host, with **1000 RPS ceiling** and oha latency correction. c is the maximum active connection count; achieved load can be below that ceiling, especially at c=1. This is **not maximum capacity**. Existing deployed response bodies identify their server and are not identical to the controlled fixture. Runtime patch levels can differ from the EC2 Node version.
- No deployed Lambda settings or code changes. Raw measured/warmup JSON, commands, hashes, versions, CPU snapshots, generator usage and configuration snapshots are retained. Throughput sums 2xx counts / elapsed durations; reported latency percentiles are medians of repeat-level successful percentiles, not pooled percentiles.
- With five repeats, small differences remain **not statistically conclusive**. Paired ratios below describe these runs, not a population confidence interval or proof of general framework superiority.

Host tools: Node **v24.22.2**, **oha 1.16.0**, Bun **1.4.4**. Packages: express 5.3.0, hono 4.13.14, @hono/node-server 2.1.5, h3 2.0.8.

## Controlled framework efficiency

Higher RPS is better; lower latency and CPU/request are better. Flagged controlled cells: **0**. Inspect individual trials before ranking; the table preserves all measurements, including flagged ones.

| Server    | c   | Repeats | Successful RPS ↑ | Run RPS range     | Median run p50 ↓ ms | Median run p95 ↓ ms | Server CPU ↓ ms/1k successes | Max generator CPU fraction | Errors |
| --------- | --- | ------- | ---------------- | ----------------- | ------------------- | ------------------- | ---------------------------- | -------------------------- | ------ |
| express   | 1   | 5       | 20863.48         | 20489.63–21273.15 | 0.05                | 0.05                | 45.22                        | 10.67%                     | 0      |
| hono      | 1   | 5       | 26487.33         | 24603.22–27119.88 | 0.03                | 0.04                | 34.43                        | 13.76%                     | 0      |
| h3        | 1   | 5       | 16755.38         | 16443.30–16910.30 | 0.06                | 0.07                | 57.34                        | 8.63%                      | 0      |
| node-http | 1   | 5       | 30671.92         | 27103.22–32643.01 | 0.03                | 0.03                | 28.05                        | 16.19%                     | 0      |
| hono      | 16  | 5       | 34802.13         | 34501.04–35149.19 | 0.45                | 0.52                | 28.73                        | 15.44%                     | 0      |
| h3        | 16  | 5       | 20351.97         | 19780.84–20916.42 | 0.78                | 1.02                | 49.13                        | 9.32%                      | 0      |
| express   | 16  | 5       | 26562.62         | 24841.35–27447.34 | 0.58                | 0.64                | 37.64                        | 12.09%                     | 0      |
| node-http | 16  | 5       | 42661.95         | 42015.57–43201.29 | 0.36                | 0.44                | 23.44                        | 18.89%                     | 0      |
| node-http | 64  | 5       | 40985.97         | 39430.28–42517.79 | 1.53                | 1.75                | 24.36                        | 19.03%                     | 0      |
| h3        | 64  | 5       | 20376.91         | 19507.88–21018.98 | 3.10                | 3.53                | 48.99                        | 9.65%                      | 0      |
| express   | 64  | 5       | 26614.30         | 26203.12–27269.70 | 2.38                | 2.67                | 37.52                        | 12.35%                     | 0      |
| hono      | 64  | 5       | 33875.41         | 33221.80–34475.38 | 1.85                | 2.12                | 29.47                        | 15.58%                     | 0      |
|           |     |         |                  |                   |                     |                     |                              |                            |        |

![Controlled throughput at c=64, higher is better.](results/framework-2026-11-03T22-28-42-423Z/controlled-throughput.svg)

![Controlled server CPU per 1,000 successful requests at c=64, lower is better.](results/framework-2026-11-03T22-28-42-423Z/controlled-cpu.svg)

## Express versus Hono — paired controlled observations

RPS ratio = Express / Hono: above 1 favors Express throughput. CPU ratio = Express / Hono CPU per successful request: below 1 favors Express efficiency. Only paired blocks where both samples passed the basic error/generator-utilization checks appear here.

| c | Repeat | Express RPS | Hono RPS | Express/Hono RPS ratio | Express/Hono CPU ratio |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 20702.91 | 26745.18 | 0.7741 | 1.3284 |
| 1 | 2 | 20894.29 | 26959.75 | 0.7750 | 1.3376 |
| 1 | 3 | 20957.42 | 27008.60 | 0.7760 | 1.3328 |
| 1 | 4 | 21273.15 | 24603.22 | 0.8646 | 1.1939 |
| 1 | 5 | 20489.63 | 27119.88 | 0.7555 | 1.3788 |
| 16 | 1 | 27134.08 | 34774.32 | 0.7803 | 1.2815 |
| 16 | 2 | 27337.11 | 34501.04 | 0.7924 | 1.2620 |
| 16 | 3 | 24841.35 | 34717.61 | 0.7155 | 1.3976 |
| 16 | 4 | 27447.34 | 35149.19 | 0.7809 | 1.2807 |
| 16 | 5 | 26053.25 | 34868.48 | 0.7472 | 1.3384 |
| 64 | 1 | 27269.70 | 34006.20 | 0.8019 | 1.2478 |
| 64 | 2 | 26649.06 | 33221.80 | 0.8022 | 1.2460 |
| 64 | 3 | 26226.85 | 34475.38 | 0.7607 | 1.3141 |
| 64 | 4 | 26722.78 | 33651.58 | 0.7941 | 1.2594 |
| 64 | 5 | 26203.12 | 34022.09 | 0.7702 | 1.2991 |


## Deployed Web Function latency under bounded load

**1000 RPS ceiling, not maximum capacity.** Use latency/error observations at comparable achieved load; reaching the ceiling does not establish identical throughput capacity. CPU cannot be attributed by making a single telemetry request to a load-balanced function, so no per-cell server CPU is invented here.

**Corrected latency includes scheduling backlog**, not just HTTP response time. At c=1, the single connection cannot sustain the requested 1000 RPS: achieved throughput is much lower and corrected percentiles grow into seconds as requests fall behind their scheduled start times. Those values describe an overloaded arrival schedule, **not multi-second Lambda response times**. Do not compare them directly with the uncorrected controlled-pass percentiles or use them to rank endpoint service latency.

| Server | c | Repeats | Successful RPS (bounded) | Run RPS range | Median run corrected p50 ↓ ms | Median run corrected p95 ↓ ms | Server CPU ms/1k | Max generator CPU fraction | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hono | 1 | 5 | 286.64 | 268.84–305.86 | 11009.57 | 20288.44 | not attributable | 0.47% | 0 |
| node-http | 1 | 5 | 305.08 | 253.13–375.73 | 10620.83 | 19705.06 | not attributable | 0.53% | 0 |
| express | 1 | 5 | 284.41 | 254.27–328.86 | 11048.36 | 20477.90 | not attributable | 0.50% | 0 |
| h3 | 1 | 5 | 305.10 | 279.84–337.18 | 10477.74 | 19799.09 | not attributable | 0.51% | 0 |
| express | 16 | 5 | 999.88 | 999.87–999.89 | 3.46 | 4.34 | not attributable | 1.29% | 0 |
| h3 | 16 | 5 | 999.88 | 999.84–999.90 | 3.65 | 4.51 | not attributable | 1.25% | 0 |
| hono | 16 | 5 | 999.88 | 999.86–999.91 | 3.46 | 4.53 | not attributable | 1.26% | 0 |
| node-http | 16 | 5 | 999.90 | 999.86–999.92 | 3.24 | 4.27 | not attributable | 1.26% | 0 |
| node-http | 64 | 5 | 999.51 | 998.07–999.88 | 3.58 | 5.07 | not attributable | 1.35% | 55 |
| hono | 64 | 5 | 999.78 | 999.47–999.89 | 3.76 | 5.03 | not attributable | 1.33% | 12 |
| express | 64 | 5 | 999.82 | 999.76–999.87 | 3.78 | 5.29 | not attributable | 1.34% | 0 |
| h3 | 64 | 5 | 999.26 | 997.96–999.90 | 3.77 | 5.27 | not attributable | 1.34% | 91 |

## CloudWatch CPU diagnostics

[CloudWatch evidence](results/framework-2026-11-03T22-28-42-423Z/cloudwatch.json) contains whole-function CPU and executed-request aggregates over minute buckets spanning the deployed pass, including warmups, idle/background activity and possible unrelated traffic. These are **not per-cell CPU** measurements and are not substituted for the controlled same-PID measurements. Units and bucket boundaries are retained in the raw AWS response. Missing series are not zero.

## Cleanup and artifacts

Instance terminated: **true**. Runner stack deletion independently verified: **true**. Deployed configuration unchanged on read-back: **true**.

- [Run manifest and configuration](results/framework-2026-11-03T22-28-42-423Z/manifest.json)
- [Initial deployed configuration](results/framework-2026-11-03T22-28-42-423Z/configuration-before.json)
- [Final deployed configuration](results/framework-2026-11-03T22-28-42-423Z/configuration-after.json)
- [Cleanup/recovery record](results/framework-2026-11-03T22-28-42-423Z/recovery.json)
- Raw oha output, CPU snapshots, affinity evidence and commands: results/framework-2026-11-03T22-28-42-423Z/raw/
- Tool download digests and fixture hashes: run-config.json in that directory.
- Original I/O measurements: [OHA_RESULTS.md](OHA_RESULTS.md).

Reproduce: `bun run bench:run:framework --profile jolo --region eu-central-1`. This provisions a billed temporary EC2 runner and removes it after retrieving results. Shared CDK bootstrap assets are not destroyed. Regenerate this report offline with `bun run bench:report:framework`.
