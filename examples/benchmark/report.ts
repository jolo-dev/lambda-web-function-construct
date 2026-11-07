import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BenchmarkReportData, ScenarioCellResult } from "./run";

const fmt = (n: number | undefined) => n === undefined || !Number.isFinite(n) ? "not measured" : n.toFixed(2);
const isWeb = (server: string) => ["node-http", "express", "hono", "h3"].includes(server);
function table(headers: string[], rows: unknown[][]): string {
	return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
}
interface Chart { title: string; description: string; unit: string; rows: { label: string; value: number }[] }
function charts(data: BenchmarkReportData): Chart[] {
	const local = data.results.filter((r) => r.track === "localstack-lambda");
	const select = (scenario: string, concurrency: number, metric: keyof ScenarioCellResult, predicate = (_: ScenarioCellResult) => true) => local
		.filter((r) => r.scenario === scenario && r.concurrency === concurrency && predicate(r))
		.map((r) => ({ label: r.server, value: Number(r[metric]) }));
	return [
		{ title: "Concurrent I/O throughput", description: "↑ Higher is better. Historical Web c=64 and classic c=8 runs use different concurrency; not an equal-load AWS comparison.", unit: "RPS", rows: local.filter((r) => r.scenario === "async-io-30ms" && r.concurrency === (isWeb(r.server) ? 64 : 8)).map((r) => ({ label: `${r.server} c=${r.concurrency}`, value: r.rps })) },
		{ title: "Warm ping latency", description: "↓ Lower is better. Local HTTP client round trip at c=1; no Internet/TLS path.", unit: "ms p50", rows: select("ping", 1, "p50Ms") },
		{ title: "Streaming first byte", description: "↓ Lower is better. The Bun bridge and API Gateway handler buffer responses in these examples; this is not a universal classic Lambda limitation.", unit: "ms TTFB", rows: select("stream-sse", 1, "ttfbP50Ms") },
		{ title: "First request after replacement", description: "↓ Lower is better. Median of three LocalStack trials. Includes Docker/emulator startup; not a prediction of AWS cold-start latency.", unit: "ms", rows: data.coldStarts.map((c) => ({ label: c.server, value: c.medianColdStartMs })) },
		{ title: "Recorded Web code initialization", description: "↓ Lower is better. Actual platform.initReport samples only. These are separate observations, not subtractable phases of the median first-request timing.", unit: "ms init", rows: data.coldStarts.filter((c) => c.initReportDurationMs !== undefined).map((c) => ({ label: c.server, value: c.initReportDurationMs! })) },
		{ title: "Bare-process ping throughput", description: "↑ Higher is better. c=64 on the operator host, without Lambda. This isolates a different execution path than deployed endpoints.", unit: "RPS", rows: data.results.filter((r) => r.track === "bare-process" && r.scenario === "ping" && r.concurrency === 64).map((r) => ({ label: r.server, value: r.rps })) },
	];
}
function ascii(chart: Chart): string {
	const max = Math.max(...chart.rows.map((r) => r.value), 1);
	return `### ${chart.title}\n\n${chart.description}\n\n\`\`\`text\n${chart.rows.map((r) => `${r.label.padEnd(23)} ${"█".repeat(Math.max(1, Math.round(r.value / max * 28))).padEnd(28)} ${fmt(r.value)} ${chart.unit}`).join("\n")}\n\`\`\`\n`;
}
export function generateMarkdown(data: BenchmarkReportData): string {
	return `# LocalStack-only HTTP server benchmark

Generated: ${data.generatedAt} · Host: ${data.environment.hostArch} · LocalStack: ${data.environment.localstackVersion}

> **Historical emulator measurements, not an AWS performance ranking.** See [AWS_RESULTS.md](AWS_RESULTS.md) for the real AWS eu-central-1 run, equal-concurrency results, deployment differences and corrected pricing. Earlier claims of a universal winner and fixed cost savings were not supported by these LocalStack measurements.

## How to read this report

- **↑ Higher is better:** successful requests per second (RPS).
- **↓ Lower is better:** latency (p50 median, p95/p99 tail), time to first byte (TTFB), total response time (TTLB), bundle size and CPU per request for the same workload.
- These are short, single historical runs. Different concurrency, shared-host contention and emulator overhead prevent a fair cross-platform capacity ranking. Tiny timing differences are not statistically significant.
- Fewer sandboxes is not inherently better: additional environments provide additional CPU. A Web Function's configured concurrency is an upper bound, not a guarantee AWS uses exactly one sandbox at c=64.
- CPU and memory snapshots sample one sandbox, not the entire distributed function. They are not AWS billing measurements. Missing values are not fabricated.

## Graphs

${charts(data).map(ascii).join("\n")}

## Cold-start behaviour

${table(["Server", "Trial timings ↓ ms", "Median ↓ ms", "Warm ping p50 ↓ ms", "Recorded init duration ↓ ms"], data.coldStarts.map((c) => [c.server, c.trialsMs.map(fmt).join(", "), fmt(c.medianColdStartMs), fmt(c.warmP50Ms), fmt(c.initReportDurationMs)]))}

Cold trials recycle a Web revision or classic function configuration. This is not a measured 64-request cold burst. LocalStack starts Docker containers; AWS uses its own environment lifecycle, dynamic concurrency and headroom. AWS rollout must also be checked at the data plane: a successful control-plane update can still be followed by an old-revision response. Do not infer a guaranteed number of AWS cold starts from this table.

## Packaging

${table(["Server", "Deployment", "Bundle ↓ KB", "ZIP ↓ KB / image MB"], data.artifacts.map((a) => [a.server, a.deploymentModel, a.bundleKb, a.containerImageMb ? `${a.containerImageMb} MB image` : `${a.archiveKb} KB ZIP`]))}

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

${table(["Track", "Server", "Scenario", "c", "Successful RPS ↑", "p50 ↓ ms", "p95 ↓ ms", "p99 ↓ ms", "TTFB / TTLB ↓ ms", "Errors", "Sandboxes observed"], data.results.map((r) => [r.track, r.server, r.scenario, r.concurrency, r.rps, r.p50Ms, r.p95Ms, r.p99Ms, r.ttfbP50Ms === undefined ? "—" : `${r.ttfbP50Ms} / ${r.ttlbP50Ms}`, r.errorCount, r.uniqueSandboxes ?? "unknown"]))}

## Historical contract probes

${table(["Probe", "Passed", "HTTP", "Error type"], data.contractProbes.map((p) => [p.id,p.passed,p.status,p.errorTypeHeader ?? "—"]))}
`;
}
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function generateHtml(data: BenchmarkReportData): string {
	const payload = JSON.stringify(data.results).replaceAll("<", "\\u003c");
	const chartHtml = charts(data).map((chart) => {
		const max = Math.max(...chart.rows.map((r) => r.value),1);
		return `<section><h2>${escape(chart.title)}</h2><p>${escape(chart.description)}</p>${chart.rows.map((r) => `<div class="row"><code>${escape(r.label)}</code><div class="track" aria-hidden="true"><div class="fill" style="width:${r.value/max*100}%"></div></div><span>${fmt(r.value)} ${escape(chart.unit)}</span></div>`).join("")}</section>`;
	}).join("");
	const markdownBody = Bun.markdown.html(generateMarkdown(data));
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalStack-only benchmark — AWS comparison available</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0f17;color:#e6edf7;font:16px/1.6 Georgia,serif}main{max-width:1250px;margin:auto;padding:36px 28px 80px}h1,h2,h3{line-height:1.25;text-wrap:balance}h1{font-size:clamp(2rem,5vw,3rem);max-width:28ch}h2{margin-top:2.5rem}p,li{max-width:78ch}a{color:#7dd3fc;text-underline-offset:3px}section{padding-bottom:24px;border-bottom:1px solid #26334d}.notice,blockquote{padding:18px;margin:24px 0;background:#182232;border:1px solid #54718d}.row{display:grid;grid-template-columns:210px 1fr 150px;align-items:center;gap:16px;margin:10px 0;font:13px/1.5 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}.row span{text-align:right}.track{background:#182232;height:20px}.fill{height:100%;background:#38bdf8}label{display:inline-flex;flex-direction:column;gap:6px;margin:8px 16px 8px 0}select,button{padding:9px;background:#182232;color:#e6edf7;border:1px solid #54718d;font-size:14px}a:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid #7dd3fc;outline-offset:3px}table{display:block;overflow:auto;max-width:100%;border-collapse:collapse;font:12px/1.5 ui-monospace,Menlo,monospace}td,th{padding:10px;border-bottom:1px solid #26334d;text-align:left;min-width:100px}th{background:#182232}pre{overflow:auto;padding:16px;background:#131a26;font-size:12px}code{font-family:ui-monospace,Menlo,monospace}::selection{background:#305c78;color:white}@media(max-width:650px){main{padding:24px 16px}.row{grid-template-columns:1fr auto;gap:4px}.track{grid-column:1/-1;grid-row:2;height:14px}.row span{grid-column:2;grid-row:1}.row code{font-size:11px}select{max-width:100%}}
</style></head><body><main><h1>LocalStack-only HTTP server benchmark</h1><div class="notice"><strong>Do not treat this emulator run as an AWS ranking or invoice.</strong><p><a href="aws-report.html">Read the AWS eu-central-1 benchmark and cloud vs. LocalStack differences →</a></p></div>${chartHtml}
<section><h2>Scenario explorer</h2><p>Only exactly matching measurements are shown. Throughput ↑ Higher is better; latency, CPU and RSS ↓ Lower is better. Sampled CPU/RSS is not an aggregate bill.</p>
<label>Track<select id="track"><option value="localstack-lambda">LocalStack Lambda</option><option value="bare-process">Bare process</option></select></label>
<label>Scenario<select id="scenario">${["ping","json-1kb","json-64kb","async-io-30ms","stream-sse","compute-sha256"].map((s) => `<option>${s}</option>`).join("")}</select></label>
<label>Concurrency<select id="concurrency">${[1,8,16,64].map((c) => `<option>${c}</option>`).join("")}</select></label>
<label>Metric<select id="metric"><option value="rps">RPS ↑</option><option value="p50Ms">p50 latency ↓ ms</option><option value="p95Ms">p95 latency ↓ ms</option><option value="activeCpuMsPer1kReq">Sampled CPU ↓ ms/1k</option><option value="peakRssMb">Sampled RSS ↓ MB</option></select></label>
<div id="explorer" aria-live="polite"></div></section>
<details><summary>Read the full data tables, methodology and conclusion</summary>${markdownBody}</details></main><script>
const rows=${payload};
function render(){const metric=document.getElementById('metric').value;const chosen=rows.filter(r=>r.track===document.getElementById('track').value&&r.scenario===document.getElementById('scenario').value&&r.concurrency===Number(document.getElementById('concurrency').value));chosen.sort((a,b)=>metric==='rps'?b[metric]-a[metric]:a[metric]-b[metric]);const max=Math.max(...chosen.map(r=>r[metric]),1);document.getElementById('explorer').innerHTML=chosen.length?chosen.map(r=>'<div class="row"><code>'+r.server+'</code><div class="track" aria-hidden="true"><div class="fill" style="width:'+r[metric]/max*100+'%"></div></div><span>'+r[metric]+'</span></div>').join(''):'<p>No measurements at this exact concurrency. Select another level; missing values are not substituted.</p>';}
['track','scenario','concurrency','metric'].forEach(id=>document.getElementById(id).addEventListener('change',render));render();
</script></body></html>`;
}
if (import.meta.main) {
	const data = JSON.parse(readFileSync(path.join(import.meta.dir,"results/latest.json"),"utf8")) as BenchmarkReportData;
	writeFileSync(path.join(import.meta.dir,"RESULTS.md"),generateMarkdown(data));
	writeFileSync(path.join(import.meta.dir,"results/report.html"),generateHtml(data));
	console.log("Generated historical LocalStack RESULTS.md and results/report.html");
}
