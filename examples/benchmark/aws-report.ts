import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { median, summarizeCells, verifiedColdTrials, parseClassicInit, type Cell } from "./comparison";
import { readLogGroups } from "./telemetry-artifacts";

const dir = import.meta.dir;
const aws = JSON.parse(readFileSync(path.join(dir, "results/aws-latest.json"), "utf8"));
const local = JSON.parse(readFileSync(path.join(dir, "results/latest.json"), "utf8"));
const cloud = summarizeCells(aws.results);
const baseline = summarizeCells(local.results.filter((r: any) => r.track === "localstack-lambda"));
const servers: string[] = Object.keys(aws.endpoints);
const fmt = (n: number) => Number.isFinite(n) ? n.toFixed(2) : "not measured";
const get = (rows: ReturnType<typeof summarizeCells>, server: string, scenario: string, c: number) => rows.find((r) => r.server === server && r.scenario === scenario && r.concurrency === c);
function table(headers: string[], rows: unknown[][]) {
	return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
}
function graph(rows: { label: string; value: number }[], unit: string, direction: string) {
	const max = Math.max(...rows.map((r) => r.value), 1);
	return `${direction}\n\n\`\`\`text\n${rows.map((r) => `${r.label.padEnd(20)} ${"█".repeat(Math.max(1, Math.round(r.value/max*32))).padEnd(32)} ${fmt(r.value)} ${unit}`).join("\n")}\n\`\`\`\n`;
}
const coldRows = servers.map((server) => {
	const entry = aws.coldStarts.find((c: any) => c.server === server);
	const trials = verifiedColdTrials(entry?.trials ?? []) as any[];
	const stale = trials.reduce((n: number, t: any) => n+(t.propagationResponses?.length ?? 0), 0);
	const ls = local.coldStarts.find((c: any) => c.server === server);
	return { server, trials, stale, ms: median(trials.map((t: any) => t.elapsedMs)), localMs: ls?.medianColdStartMs };
});
const metricNames = [...new Set<string>((aws.telemetry?.metrics ?? []).filter((m: any) => m.datapoints?.length).map((m: any) => m.MetricName))];
const logGroups = readLogGroups(aws.telemetry, path.join(dir, "results"));
for (const [group, events] of Object.entries(readLogGroups(aws.supplementalTelemetry, path.join(dir, "results")))) {
	logGroups[group] = [...(logGroups[group] ?? []), ...events];
}
const groups = Object.keys(logGroups);
const warmupErrorTypes: Record<string, number> = {};
for (const response of aws.warmupFailures ?? []) {
	const key = response.headers["lambda-web-error-type"] ?? String(response.status);
	warmupErrorTypes[key] = (warmupErrorTypes[key] ?? 0) + 1;
}
const webQuota = aws.accountQuotas?.find((q: any) => q.QuotaName === "Arm vCPUs for all Web Functions")?.Value;
const errorCount = aws.results.reduce((n: number, c: Cell) => n+c.errorCount, 0);
const requests = aws.results.reduce((n: number, c: Cell) => n+c.totalRequests, 0);
const probeRows = (aws.contractProbes ?? []).map((p: any) => {
	const ls = local.contractProbes.find((q: any) => q.id === p.id);
	const statuses: Record<string, number> = {};
	for (const response of p.burst ?? [p]) statuses[response.status] = (statuses[response.status] ?? 0)+1;
	return [p.id, JSON.stringify(statuses), p.headers?.["lambda-web-error-type"] ?? [...new Set((p.burst ?? []).map((r: any) => r.headers["lambda-web-error-type"]).filter(Boolean))].join(", "), ls?.status ?? "not measured"];
});
const priceProducts = [
	...JSON.parse(readFileSync(path.join(dir, "results/aws-prices-eu-central-1.json"), "utf8")),
	...JSON.parse(readFileSync(path.join(dir, "results/aws-prices-apigw-eu-central-1.json"), "utf8")),
];
function price(suffix: string): number {
	const product = priceProducts.find((p: any) => p.product.attributes.usagetype === `EUC1-${suffix}`);
	if (!product) throw new Error(`Missing verified pricing product ${suffix}`);
	const terms: any = Object.values(product.terms.OnDemand)[0];
	const dimensions: any[] = Object.values(terms.priceDimensions);
	return Number((dimensions.find((d: any) => d.beginRange === "0") ?? dimensions[0]).pricePerUnit.USD);
}
const rates = {
	webRequest: price("Lambda-Web-Request-ARM"), cpu: price("Lambda-Web-vCPU-Second-ARM"),
	memory: price("Lambda-Web-Memory-GB-Second-ARM"), eventRequest: price("Request"), eventGbSecond: price("Lambda-GB-Second-ARM"),
	httpApi: price("ApiGatewayHttpRequest"),
};
// Explicit scenario, not a projection from LocalStack process counters or this brief run.
const monthlyRequests = 10_000_000, monthSeconds = 30*86400, usedMemoryGb = 0.25, cpuSecondsPerReq = 0.001;
const webExample = monthlyRequests*rates.webRequest + monthlyRequests*cpuSecondsPerReq*rates.cpu + usedMemoryGb*monthSeconds*rates.memory;
const webEightEnvironmentsExample = monthlyRequests*rates.webRequest + monthlyRequests*cpuSecondsPerReq*rates.cpu + 8*usedMemoryGb*monthSeconds*rates.memory;
const eventExample = (ms: number) => monthlyRequests*rates.eventRequest + monthlyRequests*(ms/1000)*2*rates.eventGbSecond;
const initEvents: any[] = [];
const eventReports: any[] = [];
for (const [group, events] of Object.entries(logGroups) as [string, any[]][]) {
	for (const event of events) {
		try {
			const entry = JSON.parse(event.message);
			if (entry.type === "platform.initReport") initEvents.push({ group, logStream: event.logStreamName, ...entry.record });
		} catch { /* Standard Event Lambda REPORT lines are text, not JSON. */ }
		if (event.message.startsWith("REPORT RequestId:")) eventReports.push({ group, logStream: event.logStreamName, message: event.message });
	}
}
const coldChart = graph(coldRows.map((r) => ({ label: r.server, value: r.ms })), "ms", "↓ Lower is better. Three first-request measurements per candidate; see cold-start caveats below.");
const ioChart = graph(servers.flatMap((server) => {
	const cell = get(cloud, server, "async-io-30ms", 64);
	return cell ? [{ label: server, value: cell.rps }] : [];
}), "RPS", "↑ Higher is better. Same client concurrency (64), but AWS can use different numbers of environments.");
const warmChart = graph(servers.flatMap((server) => {
	const cell = get(cloud, server, "ping", 1);
	return cell ? [{ label: server, value: cell.p50Ms }] : [];
}), "ms", "↓ Lower is better. Includes the operator-host → Frankfurt network round trip.");
const streamingChart = graph(servers.flatMap((server) => {
	const cell = get(cloud, server, "stream-sse", 1);
	return cell ? [{ label: server, value: cell.ttfbP50Ms }] : [];
}), "ms TTFB", "↓ Lower is better. Time until the first response chunk arrives, not the full response.");
const scaleChart = graph([1, 8, 16, 64].flatMap((c) => servers.flatMap((server) => {
	const cell = get(cloud, server, "async-io-30ms", c);
	return cell ? [{ label: `${server} c=${c}`, value: cell.rps }] : [];
})), "RPS", "↑ Higher is better. Measured concurrency scaling; not a per-sandbox capacity estimate.");
const tailChart = graph(servers.flatMap((server) => {
	const cell = get(cloud, server, "async-io-30ms", 16);
	return cell ? [{ label: server, value: cell.p95Ms }] : [];
}), "ms p95", "↓ Lower is better. Median of the two run-level p95 values, not a pooled percentile.");

const policyPath = path.join(dir, "results/aws-policy-propagation.json");
const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf8")) : null;
const verificationPath = path.join(dir, "results/aws-restoration-verification.json");
const verification = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, "utf8")) : null;
const policyCounts: Record<string, number> = {};
for (const response of policy?.rateResponses ?? []) {
	const key = `${response.status} ${response.headers["lambda-web-error-type"] ?? "(no error-type header)"}`;
	policyCounts[key] = (policyCounts[key] ?? 0)+1;
}
const initTable = table(["Server", "Matched AWS init durations ↓ ms", "Matched AWS init CPU ↓ ms", "Matched AWS init memory MB", "Historical LocalStack init ↓ ms"], coldRows.map((row) => {
	const samples = row.trials.map((trial: any) => {
		const stream = trial.headers["lambda-web-logstream"];
		if (stream) return initEvents.find((event) => event.logStream === stream)?.metrics;
		const id = trial.headers["x-lambda-request-id"];
		const report = id && eventReports.find((event) => event.message.includes(`REPORT RequestId: ${id}`))?.message;
		return report ? parseClassicInit(report) : undefined;
	});
	const ls = local.coldStarts.find((c: any) => c.server === row.server);
	return [row.server, samples.map((s: any) => fmt(s?.totalDurationMs)).join(", "), samples.map((s: any) => fmt(s?.totalCpuTimeMs)).join(", "), samples.map((s: any) => fmt(s?.maxMemoryUsageMb)).join(", "), fmt(ls?.initReportDurationMs)];
}));

const markdown = `# AWS cloud vs. LocalStack benchmark

Run status: **${aws.status}** · Profile: \`${aws.profile}\` · Region: **${aws.region}**  
Started: ${aws.startedAt} · Updated: ${aws.generatedAt}  
Load generator: **operator's ${aws.loadGenerator.platform} machine, outside AWS**. Measured requests: **${requests.toLocaleString()}**, errors: **${errorCount}**. Warm-up, telemetry and contract requests are additional.

> **Important correction to the earlier report:** LocalStack results do not establish an AWS-wide winner or production cost ranking. The old comparison used c=64 for Web Functions and c=8 for classic Event Lambda. This AWS run uses the same concurrency levels for every candidate. A classic Lambda's one-invocation-per-environment model does not imply low aggregate throughput: AWS scales it horizontally.

## Method and limitations

- **Capped warm run:** each Web Function endpoint temporarily uses maxEnvironments=${aws.benchmarkMaxEnvironments ?? "not recorded"}. The original settings are restored afterward. The uncapped attempt hit this account's **${webQuota ?? "not recorded"} Arm-vCPU quota** and is preserved in \`results/aws-uncapped-attempt.json\`; throttling evidence is in \`results/aws-quota-throttles.json\`. This is a resource-bounded comparison, not an unrestricted AWS capacity ranking.
- Warm-up failures retained: **${aws.warmupFailures?.length ?? 0}**, by error type: ${JSON.stringify(warmupErrorTypes)}. These are separate from measured-cell errors. A high RPS with many 429s is **not** a successful low-error workload.
- Semantic correction: ${aws.corrections ? `API Gateway ping/cold samples were rerun against /healthz after adding the alias. The original /ping samples returned AWS service-health text and are retained as discardedMeasurements, not included in summaries. Correction began ${aws.corrections.startedAt}; all 36 server/scenario preflight response bodies were validated.` : "Root /ping is reserved by API Gateway on AWS; see any correction metadata before interpreting that candidate's ping/cold samples."}
- Cold trial source: ${aws.coldStartSource ? `\`${aws.coldStartSource}\` (verified samples retained for the other five candidates from the preceding uncapped attempt; lambda-apigw uses the later /healthz correction artifact)` : "this run"}.
- Six deployed CDK stacks, Arm64, classic functions configured at 2,048 MB; Web Functions have the platform's fixed environment allocation. Equal memory configuration does **not** mean equal CPU allocation (classic Lambda CPU is proportional to memory).
- Six routes: ping, 1 KB JSON, 64 KB JSON, 30 ms async I/O, eight-chunk SSE (5 ms intervals), and 1,500 SHA-256 iterations.
- ${aws.methodology.repeats} repeats × ${aws.methodology.durationMs} ms per cell. Ping/I/O: c=1,8,16,64 for **every** candidate. Other routes: c=1,16. Server order reverses on repeat 2. Each cell attempts a pre-warm burst at the requested concurrency; retained warm-up failures mean not every slot is guaranteed warm.
- RPS = total successful requests / summed elapsed time. Displayed p50/p95/p99 are the median of the repeat-level percentiles, **not pooled percentiles**. Two brief repeats cannot establish statistical significance or tiny framework differences.
- AWS timings include WAN/TLS and service routing; LocalStack uses local HTTP. Do **not** interpret the AWS/LocalStack latency difference as pure server overhead, nor treat this as a saturation benchmark.
- Process CPU/RSS comes from **one sampled sandbox**. It is not aggregated across AWS environments and is not used to predict the bill. Web sandbox counts are distinct response logstreams per cell; they are observed lower bounds. Classic Lambda does not expose a sandbox ID in these examples, so its per-cell count is **unknown**, not 1.
- No 64-request cold burst was run. The previous claim that AWS would use exactly one Web Function environment for such a burst was an assumption, not a measurement. AWS dynamically sets concurrency and maintains headroom.
- The historical LocalStack run is preserved in \`results/latest.json\`; AWS data is separate in \`results/aws-latest.json\` and a timestamped artifact. AWS load is not mixed into the bare-process track.

## Measured AWS warm performance

${table(["Server", "Ping c=1 p50 ↓ ms", "I/O c=8 RPS ↑", "I/O c=64 RPS ↑", "I/O c=64 p95 ↓ ms", "I/O c=64 errors / attempts", "Web sandboxes seen at c=64 (per repeat)"], servers.map((server) => {
	const ping = get(cloud, server, "ping", 1), io8 = get(cloud, server, "async-io-30ms", 8), io64 = get(cloud, server, "async-io-30ms", 64);
	return [server, fmt(ping?.p50Ms ?? NaN), fmt(io8?.rps ?? NaN), fmt(io64?.rps ?? NaN), fmt(io64?.p95Ms ?? NaN), io64 ? `${io64.errorCount} / ${io64.totalRequests}` : "not measured", io64?.sandboxCounts.map((n) => n ?? "unknown").join(", ") ?? "not measured"];
}))}

### Warm request latency
${warmChart}
### Concurrent I/O throughput at c=64
${ioChart}
### Scaling from c=1 to c=64
${scaleChart}
### Tail latency at c=16
${tailChart}
### Streaming responsiveness
${streamingChart}

${table(["Server", "LocalStack TTFB / TTLB ↓ ms", "AWS TTFB / TTLB ↓ ms", "Interpretation"], servers.map((server) => {
	const a=get(cloud,server,"stream-sse",1), l=get(baseline,server,"stream-sse",1);
	return [server, l ? `${fmt(l.ttfbP50Ms)} / ${fmt(l.ttlbP50Ms)}` : "not measured", a ? `${fmt(a.ttfbP50Ms)} / ${fmt(a.ttlbP50Ms)}` : "not measured", ["bun-http","lambda-apigw"].includes(server) ? "Buffered **by this implementation/configuration**" : "Native HTTP streaming; WAN may coalesce chunks"];
}))}

The Bun bridge calls \`upstreamRes.text()\` and returns buffered JSON to the Runtime API; the API Gateway handler accumulates frames before returning. This is **not proof that every classic Lambda deployment must buffer**: Lambda Function URLs can be configured for response streaming with a streaming-capable runtime/adapter.

## Cold-start behaviour

${coldChart}
${table(["Server", "AWS first-request trials ↓ ms", "AWS median ↓ ms", "LocalStack median ↓ ms", "Old-revision responses excluded before valid trial"], coldRows.map((r) => [r.server, r.trials.map((t: any) => fmt(t.elapsedMs)).join(", "), fmt(r.ms), fmt(r.localMs), r.stale]))}

${initTable}

The AWS init values above are matched to each trial's response logstream (Web) or Lambda request ID (classic REPORT line). They are actual platform initialization measurements, not framework-only startup times; missing CPU/init fields remain unmeasured. In particular, LocalStack's 9–30 ms init reports did **not** predict AWS's runtime initialization durations.

Each Web trial creates a fresh revision, waits for the control plane, then checks that the response's \`lambda-web-logstream\` contains the expected revision ID. Responses still routed to an old revision are retained in \`propagationResponses\` and excluded from the timing. Classic trials change a nonce while preserving other environment variables and wait for the Lambda update waiter.

These are **first-request-after-replacement** times, including transport overhead. They are not a complete distribution of naturally occurring AWS cold starts. Web Functions may create headroom ahead of demand. Three samples are too few to rank cold-start reliability. We do not subtract an arbitrary init time from end-to-end latency and label the remainder "container provisioning".

Distinct Web logstreams count environments visited over a cell, **not necessarily simultaneously active environments**. AWS's dynamic concurrency can remain below the configured maximum; limiting environments to ${aws.benchmarkMaxEnvironments ?? "the benchmark cap"} can cause EndpointMaxEnvThrottle errors before the platform adapts. Such errors are retained, not excluded from the report.

## Observed AWS vs. LocalStack differences

${table(["Area", "AWS cloud", "LocalStack / implication"], [
	["Deployment", "All six stacks deployed through CloudFormation in eu-central-1; container pushed to regional ECR", "Local Docker and emulated CloudFormation in us-east-1; image build/pull and scheduling differ"],
	["CloudWatch Logs IAM", "Initial deployment served HTTP but created no Web Function logs until execution roles received scoped logs:CreateLogGroup/CreateLogStream/PutLogEvents permissions", "LocalStack had emitted init logs without these permissions, masking the missing execution-role policy. Fixed in src/web-function.ts"],
	["API Gateway /ping", "Reserved root /ping returned Healthy Connection without invoking Lambda. Discarded those ping/cold observations; added /healthz and reran them with semantic validation", "Historical LocalStack forwarded /ping to the handler. HTTP 200 alone was insufficient to validate parity"],
	["Revision rollout", "Preflight observed old revision responses even after an update was reported successful; measured run verifies the response revision", "LocalStack's near-immediate switch did not expose the same propagation hazard"],
	["Account quota", `Actual applied Arm-vCPU quota: ${webQuota ?? "not collected"}. Uncapped attempt recorded AccountActiveVCPUArm64Throttles; capped warm runs also retain EndpointMaxEnvThrottle warm-up/error observations`, "LocalStack's historical run did not enforce the same account-wide cloud quota"],
	["Scaling", "Dynamic per-environment concurrency and proactive headroom; observed counts shown above, never assumed to equal one", "Historical Web runs reported one sandbox at c=64. Classic containers competed for the same local machine; not a model of distributed AWS capacity"],
	["CPU/memory metrics", `Non-empty AWS metric names: ${metricNames.join(", ") || "not yet published/collected"}`, "LocalStack omitted EnvironmentCPUTime and EnvironmentMaxMemoryUsage; process snapshots were a workaround, not billing data"],
	["Log delivery", `${groups.length} matching groups collected; telemetry can arrive asynchronously`, "LocalStack's local log availability is not a guarantee of immediate AWS centralized log delivery"],
	["Tooling", "Installed AWS CLI 2.37.7 did not recognize lambda-web; current boto3 supports it and was used for control-plane actions", "LocalStack's bundled boto3 already included the service model"],
	["Network", "Public HTTPS from operator host to Frankfurt", "Local HTTP to containers; timings are not directly equivalent"],
])}

### HTTP contract and rate-limit observations
${table(["Probe", "AWS immediate HTTP statuses (count)", "AWS error type", "Historical LocalStack status"], probeRows)}

${policy ? `**Propagation-aware follow-up** (separate artifact results/aws-policy-propagation.json): disabling the endpoint was verified with statuses ${policy.disabledAttempts.map((r: any) => r.status).join(", ")}; re-enabling still returned ${policy.enabledAttempts.map((r: any) => r.status).join(", ")} while the data plane converged. A subsequent bounded 1,000-request scheduled test recorded **${JSON.stringify(policyCounts)}**. The HTTP 503 responses without an error-type header are retained as unattributed service errors, not silently counted as successful requests or attributed to a guessed cause. Endpoint settings were restored again afterward. The initial 200/all-200 probe observations above were premature, not evidence that AWS ignores rate settings.` : "No propagation-aware follow-up artifact was collected."}

The rate burst is a bounded 160-request test, not a guaranteed sustained arrival rate of 100+ RPS. Zero throttles would not disprove enforcement. The historical max-environments=2/concurrency=2 probe was **not** repeated in this AWS run; no AWS parity claim is made for it. Original endpoint routing, scaling and throttling settings and classic environment variables are restored after the run. Restoration result: \`${JSON.stringify(aws.restoration)}\`.

${verification ? `A final independent read-back at ${verification.at} verified all original endpoint settings and classic environment variables. Removed ${verification.experimentalRevisionCleanup.removedTotal} unrouted experimental Web revisions, retaining the four CloudFormation-managed revisions. Evidence and six stack statuses: results/aws-restoration-verification.json. The six deployed stacks themselves remain running.` : "No independent restoration read-back artifact was collected."}

## Cost corrections and Frankfurt rates

The previous illustrative ~$2.06/10M Web Function estimate used incorrect Web request/compute rates and assumed perfect packing with no memory residency between requests. **Do not use that estimate or the previous 7×–58× savings claims for AWS budgeting.**

Prices retrieved from the AWS Price List API for **eu-central-1**, stored in \`results/aws-prices-eu-central-1.json\` (USD on-demand, before discounts/free tier):

${table(["Component", "Verified rate"], [
	["Web Function requests", `$${fmt(rates.webRequest*1_000_000)} / million`],
	["Web active CPU", `$${rates.cpu} / vCPU-second`],
	["Web consumed memory", `$${rates.memory} / GB-second while the environment runs, including between requests`],
	["Classic Event Lambda requests", `$${fmt(rates.eventRequest*1_000_000)} / million`],
	["Classic Arm compute, first tier", `$${rates.eventGbSecond} / allocated GB-second`],
	["HTTP API Gateway, first 300M requests", `$${fmt(rates.httpApi*1_000_000)} / million requests; separate from Lambda`],
])}

**Example, not a measured bill:** 10M monthly requests, 1 ms active CPU/request, one Web environment resident for 30 days consuming 0.25 GB, versus a 2 GB classic function billed for 50 ms or 500 ms per request. The Web scenario costs **$${fmt(webExample)}**; the classic compute+request scenarios cost **$${fmt(eventExample(50))}** and **$${fmt(eventExample(500))}**, **before API Gateway**. With **eight** such Web environments resident for the month, the same illustrative calculation becomes **$${fmt(webEightEnvironmentsExample)}**, even before background CPU/logging. If Web headroom creates more resident environments or memory/CPU is higher, its cost rises. If classic Lambda is right-sized below 2 GB, its cost falls. We have not measured those monthly assumptions.

### Illustrative monthly totals including API Gateway

The same assumptions above, now including HTTP API request charges where applicable. Web CPU and resident memory are held constant; classic durations are **billed function time**, not client WAN latency. These are modeled configurations, not measured framework-specific bills.

${table(["Configuration", "10M requests / 30 days, USD ↓"], [
	["Web Functions: one resident environment × 0.25 GB, 1 ms active CPU/request", `$${fmt(webExample)}`],
	["Web Functions: eight resident environments × 0.25 GB each, 1 ms active CPU/request", `$${fmt(webEightEnvironmentsExample)}`],
	["Bun + Function URL: 2 GB, 50 ms billed/request", `$${fmt(eventExample(50))}`],
	["Classic Lambda + HTTP API: 2 GB, 50 ms billed/request", `$${fmt(eventExample(50)+monthlyRequests*rates.httpApi)}`],
	["Bun + Function URL: 2 GB, 500 ms billed/request", `$${fmt(eventExample(500))}`],
	["Classic Lambda + HTTP API: 2 GB, 500 ms billed/request", `$${fmt(eventExample(500)+monthlyRequests*rates.httpApi)}`],
])}

The HTTP API fee alone is **$${fmt(monthlyRequests*rates.httpApi)} for 10M requests** in Frankfurt. Source: results/aws-prices-apigw-eu-central-1.json; calculation assumptions and breakdowns: results/aws-cost-scenarios.json. Function URLs have no additional gateway request fee; normal Lambda and data-transfer charges still apply. The four Web frameworks use the same pricing model, but their actual CPU/memory usage can differ; no measured cost ranking among them is established here.

This short run is not an invoice. CloudWatch is best-effort and billing data arrives later. ECR/S3 storage, CDK custom-resource Lambdas, log ingestion/storage, data transfer, taxes, discounts and free-tier usage are not included in the example. Initialization/background CPU beyond the assumed per-request CPU is also excluded. Do not infer costs from client WAN latency.

## Conclusion — when to use what

- **Hono / h3 on Web Functions:** good default candidates for Node.js HTTP apps needing routing, middleware, concurrent I/O and native streaming. Choose ecosystem and maintainability first; small framework differences in this WAN test are not conclusive.
- **node:http on Web Functions:** choose for very small services/proxies where avoiding dependencies outweighs writing routing/body handling yourself.
- **Express on Web Functions:** choose for existing Express apps; test your application's startup and middleware rather than assuming this tiny benchmark predicts it.
- **Classic Lambda + HTTP API Gateway:** choose when you want API Gateway HTTP API routing/JWT authorization or existing API contracts. Classic Lambda also supports non-HTTP triggers, but SQS/S3/etc. do **not** require an API Gateway. HTTP APIs do **not** provide usage plans/API keys; those require REST APIs. Horizontal scaling can deliver substantial aggregate throughput, so do not reject classic Lambda based on LocalStack's c=8 result.
- **Bun container + Function URL:** choose when Bun/native binaries/container packaging are requirements. This bridge is buffered and one-invocation-per-environment; that is a trade-off of the deployed example, not evidence Bun's HTTP engine is slow. Other supported languages may use managed runtimes or ZIP/custom runtimes; container images are not mandatory for every non-Node language.
- **For a production performance decision:** repeat with an AWS-hosted load generator in eu-central-1, longer runs, more repeats, comparable arrival rates, billed-duration/CPU/memory measurements, and realistic database dependencies. This run validates cloud behaviour and exposes emulator assumptions; it does not establish a universal best server.

## Full AWS results

${table(["Server", "Scenario", "c", "Repeats", "Successful RPS ↑", "Run RPS range", "Median run p50 ↓ ms", "Median run p95 ↓ ms", "Errors"], cloud.map((r) => [r.server,r.scenario,r.concurrency,r.repeats,fmt(r.rps),r.rpsRange.map(fmt).join("–"),fmt(r.p50Ms),fmt(r.p95Ms),r.errorCount]))}

## Log collection

Collected ${initEvents.length} Web init-report events (centralized and .local copies may duplicate events) and ${eventReports.length} classic REPORT lines. Full metric dimensions are retained in the JSON; raw messages, timestamps and streams are retained losslessly in the checksum-verified gzip archives referenced by telemetry.logArchive and supplementalTelemetry.logArchive. The metric/log windows cover the uncapped attempt, capped run and any correction windows; they are diagnostic evidence, not billing attribution to timed cells. Missing init logs are not replaced with invented values.

## Reproduce / clean up

\`\`\`sh
python3 -m venv .venv-bench
.venv-bench/bin/pip install boto3
AWS_PROFILE=jolo AWS_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \\
  bunx cdk synth --all --app 'bun run examples/benchmark/cdk-app.ts' --output cdk.out.aws
bunx cdk diff --all --app cdk.out.aws --profile jolo --no-change-set
bunx cdk deploy --all --app cdk.out.aws --profile jolo --require-approval never
BENCH_PYTHON=.venv-bench/bin/python bun run examples/benchmark/aws-run.ts --profile jolo --region eu-central-1
bun run examples/benchmark/aws-report.ts
# When finished with the public benchmark endpoints (not executed automatically):
bunx cdk destroy --all --app cdk.out.aws --profile jolo --force
\`\`\`

On interruption, restore with \`aws-control.py --profile jolo --region eu-central-1 restore < results/aws-snapshot-<run-id>.json\` (use the correct snapshot). Never re-run LocalStack's \`bench:deploy\` command expecting it to target AWS.

Sources: [HTTP semantics](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-http.html), [scaling](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html), [monitoring and required logging permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring.html), [pricing and memory residency](https://aws.amazon.com/lambda/pricing/).
`;
writeFileSync(path.join(dir, "AWS_RESULTS.md"), markdown);
const body = Bun.markdown.html(markdown);
writeFileSync(path.join(dir, "results/aws-report.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AWS vs. LocalStack benchmark</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0f17;color:#e6edf7;font:16px/1.65 Georgia,serif}main{max-width:1160px;margin:auto;padding:40px 28px 80px}h1,h2,h3{font-family:Georgia,serif;line-height:1.2;text-wrap:balance}h1{font-size:clamp(2rem,5vw,3.4rem);max-width:25ch}h2{margin-top:2.8rem;font-size:1.8rem}h3{margin-top:2rem}p,li{max-width:78ch}a{color:#7dd3fc;text-underline-offset:3px}a:focus-visible{outline:2px solid #7dd3fc;outline-offset:4px}blockquote{margin:28px 0;padding:12px 20px;border:1px solid #54718d;background:#131a26}pre{overflow:auto;max-width:100%;padding:20px;background:#131a26;border:1px solid #26334d;line-height:1.7;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}table{display:block;overflow:auto;border-collapse:collapse;max-width:100%;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:12px;border-bottom:1px solid #26334d;min-width:110px}th{color:#b9cadc;background:#182232}::selection{background:#305c78;color:white}@media(max-width:600px){main{padding:24px 16px}pre{padding:12px;font-size:11px}h2{font-size:1.4rem}}
</style></head><body><main><p><a href="report.html">Historical LocalStack dashboard</a> · <a href="aws-latest.json">AWS raw data</a></p>${body}</main></body></html>`);
console.log(`Generated AWS_RESULTS.md and results/aws-report.html (${aws.status})`);
