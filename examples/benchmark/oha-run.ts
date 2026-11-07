import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildOhaArgs, parseOhaResult, summarizeOhaCells, parseAwsCliOutput, stableJson } from "./oha";
import { pingPath, validateWorkloadResponse } from "./run";
import { writeOhaReport } from "./oha-report";

const args = parseArgs({ options: {
	profile: { type: "string" }, region: { type: "string" },
	duration: { type: "string", default: "30" }, repeats: { type: "string", default: "2" },
	warmup: { type: "string", default: "5" },
} }).values;
if (!args.profile || !args.region) throw new Error("Supply --profile and --region explicitly");
const duration = Number(args.duration), repeats = Number(args.repeats), warmup = Number(args.warmup);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || !Number.isInteger(warmup) || warmup < 1 || warmup > 15) throw new Error("Use 1–3 repeats and 1–15 seconds warm-up");
buildOhaArgs("https://example.com", 64, duration);
const SERVERS = ["node-http", "express", "hono", "h3", "bun-http", "lambda-apigw"];
const startedAt = new Date().toISOString(), id = startedAt.replace(/[:.]/g, "-");
const directory = path.join(import.meta.dir, "results", `oha-${id}`);
mkdirSync(directory, { recursive: true });
const environment = { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_PAGER: "" };
for (const key of Object.keys(environment)) if (key.startsWith("AWS_ENDPOINT_URL")) delete environment[key];
function aws(service: string, operation: string, ...parameters: string[]): any {
	return parseAwsCliOutput(execFileSync("aws", [service, operation, ...parameters,
		"--profile", args.profile!, "--region", args.region!, "--output", "json", "--no-cli-pager"],
		{ encoding: "utf8", env: environment, timeout: 120000, maxBuffer: 16*1024*1024 }), service === "lambda" && operation === "get-function-concurrency");
}
function save(name: string, data: unknown) {
	writeFileSync(path.join(directory, name), JSON.stringify(data, (_,v)=>typeof v === "bigint" ? v.toString() : v, 2)+"\n");
}
function cloudResource(type: string, identifier: string) {
	return JSON.parse(aws("cloudcontrol", "get-resource", "--type-name", type, "--identifier", identifier).ResourceDescription.Properties);
}
function readState() {
	const identity = aws("sts", "get-caller-identity");
	const web: Record<string, any> = {}, classic: Record<string, any> = {}, endpoints: Record<string, string> = {};
	for (const server of SERVERS.slice(0,4)) {
		const arn = `arn:aws:lambda:${args.region}:${identity.Account}:web-function/bench-${server}`;
		const endpoint = cloudResource("AWS::Lambda::WebFunctionEndpoint", `${arn}/endpoint/prod`);
		const revisions = endpoint.RevisionWeights.map((weight: any) => cloudResource("AWS::Lambda::WebFunctionRevision", `${arn}/revision/${weight.RevisionId}`));
		web[server] = { endpoint, revisions };
		endpoints[server] = `https://${endpoint.DomainName}`;
	}
	for (const server of SERVERS.slice(4)) {
		const config = aws("lambda", "get-function-configuration", "--function-name", `bench-${server}`);
		const concurrency = aws("lambda", "get-function-concurrency", "--function-name", `bench-${server}`);
		classic[server] = { functionName: config.FunctionName, memoryMb: config.MemorySize,
			timeoutSeconds: config.Timeout, architectures: config.Architectures, runtime: config.Runtime,
			codeSha256: config.CodeSha256, lastUpdateStatus: config.LastUpdateStatus, concurrency };
	}
	endpoints["bun-http"] = aws("lambda", "get-function-url-config", "--function-name", "bench-bun-http").FunctionUrl.replace(/\/$/, "");
	const stack = aws("cloudformation", "describe-stacks", "--stack-name", "LambdaApiGwStack").Stacks[0];
	endpoints["lambda-apigw"] = stack.Outputs.find((o: any)=>o.OutputKey === "lambdaApiGwUrl").OutputValue.replace(/\/$/, "");
	const quota = aws("service-quotas", "get-service-quota", "--service-code", "lambda", "--quota-code", "L-A19E4180").Quota;
	return { at: new Date().toISOString(), identity, endpoints, web, classic,
		webArmVcpuQuota: { value: quota.Value, adjustable: quota.Adjustable, code: quota.QuotaCode },
		classicAccount: aws("lambda", "get-account-settings").AccountLimit };
}
function comparable(state: any) {
	return { endpoints: state.endpoints, classic: state.classic, web: Object.fromEntries(Object.entries(state.web).map(([server,value]: [string,any]) => [server, {
		revisionWeights: value.endpoint.RevisionWeights, scaling: value.endpoint.ScalingConfig,
		throttle: value.endpoint.ThrottleConfig, auth: value.endpoint.AuthType,
		revisions: value.revisions.map((r: any)=>({ id: r.RevisionId, service: r.ServiceConfig, build: r.BuildConfig })),
	}])) };
}
function collectMetrics(end: string) {
	const queries: any[] = [];
	for (const server of SERVERS) {
		const isWeb = SERVERS.indexOf(server)<4;
		const metrics = isWeb ? [["EndpointActiveEnvironments","Maximum"],["AccountActiveVCPUArm64Throttles","Sum"],["EndpointActiveEnvironmentThrottles","Sum"]] : [["ConcurrentExecutions","Maximum"],["Throttles","Sum"]];
		for (const [metric,stat] of metrics) queries.push({ Id: `m${queries.length}`, Label: `${server}:${metric}`,
			MetricStat: { Metric: { Namespace: isWeb ? "AWS/Lambda/Web/Usage" : "AWS/Lambda", MetricName: metric,
				Dimensions: [{Name:"FunctionName",Value:`bench-${server}`}, ...(isWeb ? [{Name:"EndpointName",Value:"prod"},{Name:"ExecutionRegion",Value:args.region}] : [])] },
				Period: 60, Stat: stat }, ReturnData: true });
	}
	save("cloudwatch-queries.json", queries);
	return aws("cloudwatch", "get-metric-data", "--metric-data-queries", JSON.stringify(queries), "--start-time", startedAt, "--end-time", end);
}
const version = execFileSync("oha", ["--version"], {encoding:"utf8"}).trim();
const report: any = { status: "running", startedAt, profile: args.profile, region: args.region,
	loadGenerator: { tool: version, orchestrator: `Bun ${Bun.version}`, platform: `${os.platform()}/${os.arch()}`, hostCpus: os.cpus().length },
	methodology: { scenario: "async-io-30ms", path: "/io?delayMs=30", concurrencies: [1,8,16,64], durationSeconds: duration, repeats, warmupSeconds: warmup,
		protocol: "HTTP/1.1", loadModel: "closed-loop fixed connection concurrency; one request per connection", configMutations: false,
		percentiles: "median of run-level successful-response percentiles, not pooled", successfulThroughput: "2xx responses / sum of oha elapsed seconds" },
	directory: path.relative(import.meta.dir, directory), cells: [], preflights: [], warmups: [] };
function checkpoint() {
	report.updatedAt = new Date().toISOString();
	save("manifest.json", report);
	writeFileSync(path.join(import.meta.dir,"results/oha-aws-latest.json"),JSON.stringify(report,null,2)+"\n");
}
async function runOha(server: string, concurrency: number, repeat: number, seconds: number, phase: string, dns: { resolvedAt: string; addresses: string[] }) {
	const stem = `${server}-c${concurrency}-r${repeat}-${phase}`;
	const command = buildOhaArgs(`${report.before.endpoints[server]}/io?delayMs=30`, concurrency, seconds, dns.addresses);
	const cellStart = new Date().toISOString();
	const child = Bun.spawn(["oha", ...command], {stdout:"pipe",stderr:"pipe"});
	const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
	writeFileSync(path.join(directory,`${stem}.json`),stdout);
	writeFileSync(path.join(directory,`${stem}.stderr.txt`),stderr);
	if (exit !== 0) throw new Error(`oha exit ${exit}: ${stem}: ${stderr}`);
	const parsed = parseOhaResult(JSON.parse(stdout));
	return { server, concurrency, repeat, phase, startedAt: cellStart, endedAt: new Date().toISOString(),
		...parsed, dns, command: ["oha",...command], rawFile: `${report.directory}/${stem}.json`,
		rawSha256: createHash("sha256").update(stdout).digest("hex"),
		childResourceUsage: JSON.parse(JSON.stringify(child.resourceUsage(),(_,v)=>typeof v === "bigint" ? v.toString() : v)) };
}
function writeSummary() {
	const rows = summarizeOhaCells(report.cells);
	const fmt = (n: number | null) => n === null ? "not measured" : n.toFixed(2);
	const table = (headers: string[], values: unknown[][]) => `| ${headers.join(" | ")} |\n| ${headers.map(()=>"---").join(" | ")} |\n${values.map(v=>`| ${v.join(" | ")} |`).join("\n")}\n`;
	const statusTable = rows.map(r=>[r.server,r.concurrency,r.repeats,fmt(r.successfulRps),`${fmt(r.rpsRange[0])}–${fmt(r.rpsRange[1])}`,fmt(r.p50Ms),fmt(r.p95Ms),r.httpFailures,r.transportErrors,`${fmt(r.failureRate*100)}%`]);
	const limits = SERVERS.map(server=>{
		const w = report.before?.web[server], c = report.before?.classic[server];
		return [server,w ? w.endpoint.ScalingConfig?.MaxEnvironments ?? "not explicitly capped" : c?.concurrency.ReservedConcurrentExecutions ?? "not reserved/capped per function",
			w ? w.revisions[0]?.ServiceConfig?.MaxConcurrencyPerEnvironment ?? "service default" : "1 invocation",
			w ? "platform fixed" : c?.memoryMb];
	});
	const metricRows = (report.cloudwatch?.MetricDataResults ?? []).map((m: any)=>[m.Label,m.StatusCode,m.Values.length,
		m.Values.length ? fmt(m.Label.endsWith("Throttles") ? m.Values.reduce((a:number,b:number)=>a+b,0) : Math.max(...m.Values)) : "not published"]);
	const markdown = `# oha AWS benchmark results\n\nStatus: **${report.status}** · Tool: **${version}** · Profile: **${args.profile}** · Region: **${args.region}**\n\nStarted: ${startedAt} · Updated: ${report.updatedAt}\n\n## Method\n\n- Six deployed servers; application responses validated before load, using /healthz for API Gateway rather than its reserved /ping.\n- GET /io?delayMs=30; c=1,8,16,64; ${repeats} repeats of ${duration} seconds, each preceded by ${warmup} seconds of oha warm-up. Warm-ups are retained but excluded from measured totals.\n- HTTP/1.1 with keep-alive, compression disabled, 15-second request timeout. Here c is simultaneous connections with one in-flight request each. Fixed-concurrency closed loop, not a fixed arrival-rate test; no coordinated-omission correction is claimed.\n- macOS /etc/resolv.conf contains a scoped IPv6 nameserver that oha 1.16.0 cannot parse. The TypeScript wrapper resolves IPv4 addresses through the OS and supplies all returned addresses with --connect-to, sharing the same mapping between warm-up and measurement. Original URL/Host/TLS verification are preserved; no system DNS changes. Resolved addresses and timestamps are recorded per cell. oha may still emit its resolver-initialization warning in retained stderr. DNS resolver performance and IPv6 are not benchmarked.\n- Only one candidate is loaded at a time. Candidate order and concurrency order reverse on the second repeat.\n- The generator runs on the operator's ${report.loadGenerator.platform} host, not within AWS; results include WAN/TLS. This is not a maximum-capacity or per-vCPU efficiency test.\n- **No AWS configuration changes**: unlike the earlier run, no artificial eight-environment cap is introduced. Actual applied limits are recorded below. Web account quota: **${report.before?.webArmVcpuQuota.value ?? "unknown"} Arm vCPUs**; classic account concurrency quota: **${report.before?.classicAccount.ConcurrentExecutions ?? "unknown"}**. These are different resource budgets, not unlimited or equal compute.\n- Raw oha JSON is kept byte-for-byte. oha summary.successRate is a transport-completion measure and can be 100% despite HTTP 429; this summary counts **only HTTP 2xx** as API successes. HTTP failures and transport errors are retained separately.\n- Throughput is summed 2xx responses / summed oha elapsed seconds, including request drain. Latencies are medians of repeat-level successful-response percentiles, not pooled percentiles.\n- This focused run measures concurrent I/O only; it does not rerun CPU/JSON/streaming/cold-start cases or establish a cost winner.\n\n## Actual configuration\n\n${table(["Candidate","Environment / reserved concurrency limit","Max requests per environment","Classic memory MB"],limits)}\nConfiguration unchanged on before/after read-back: **${report.configurationUnchanged ?? "pending"}**. AWS snapshots and quotas are saved in the run directory.\n\n## Results\n\nHigher successful RPS is better; lower latency/error rate is better. **A throttled row is quota/scaling-constrained service behavior, not an unrestricted runtime limit.**\n\n${table(["Server","c","Repeats","Successful RPS ↑","Run RPS range","Median run p50 ↓ ms","Median run p95 ↓ ms","HTTP failures","Transport errors","Failure rate ↓"],statusTable)}\n## CloudWatch diagnostic evidence\n\n${table(["Candidate:metric","Query status","Points","Maximum environments/concurrency or summed throttle count"],metricRows)}\nCloudWatch uses one-minute aggregates over the whole run, includes warm-ups and possible unrelated traffic, and can arrive late. It is not per-cell attribution; an absent series is not proof of zero throttling.\n\n## Artifacts and reproduction\n\n- [Manifest with every exact command, timings, hashes and oha child resource usage](${report.directory}/manifest.json)\n- [Initial AWS configuration](${report.directory}/configuration-before.json)\n- [Final AWS configuration](${report.directory}/configuration-after.json)\n- Raw measured and warm-up JSON plus stderr files: ${report.directory}/\n- Newest machine-readable index: results/oha-aws-latest.json\n\n\`\`\`sh\nbun run bench:run:oha --profile ${args.profile} --region ${args.region}\n\`\`\`\n${report.error ? `\nRun error: ${report.error}\n` : ""}`;
	writeOhaReport(markdown,report,import.meta.dir);
}
try {
	report.before = readState(); save("configuration-before.json",report.before); checkpoint();
	for (const server of SERVERS) for (const route of [pingPath(server),"/io?delayMs=30"]) {
		const response = await fetch(report.before.endpoints[server]+route,{signal:AbortSignal.timeout(15000)});
		const body = await response.text();
		if (response.status !== 200) throw new Error(`${server} preflight HTTP ${response.status}`);
		validateWorkloadResponse(server,route.startsWith("/io") ? "async-io-30ms" : "ping",body);
		report.preflights.push({server,path:route,status:response.status,body,headers:Object.fromEntries(response.headers)});
	}
	checkpoint();
	for (let repeat=1;repeat<=repeats;repeat++) {
		const servers = repeat%2 ? SERVERS : [...SERVERS].reverse();
		const concurrencies = repeat%2 ? [1,8,16,64] : [64,16,8,1];
		for (const concurrency of concurrencies) for (const server of servers) {
			const hostname = new URL(report.before.endpoints[server]).hostname;
			const addresses = [...new Set((await lookup(hostname,{family:4,all:true})).map(result=>result.address))];
			const dns = {resolvedAt:new Date().toISOString(), addresses};
			report.warmups.push(await runOha(server,concurrency,repeat,warmup,"warmup",dns));
			const cell = await runOha(server,concurrency,repeat,duration,"measured",dns);
			report.cells.push(cell);
			console.log(`[oha ${repeat}/${repeats}] ${server} c=${concurrency}: ${cell.successfulRps.toFixed(1)} successful RPS, ${(100*cell.failureRate).toFixed(2)}% failures`);
			checkpoint(); writeSummary();
		}
	}
	report.measuredEnd = new Date().toISOString();
	report.after = readState(); save("configuration-after.json",report.after);
	report.configurationUnchanged = stableJson(comparable(report.before)) === stableJson(comparable(report.after));
	if (!report.configurationUnchanged) throw new Error("AWS configuration changed during the benchmark; inspect before/after snapshots");
	console.log("Waiting 65 seconds for CloudWatch publication...");
	await Bun.sleep(65000);
	report.cloudwatch = collectMetrics(report.measuredEnd); save("cloudwatch.json",report.cloudwatch);
	report.status = "complete";
} catch (error) {
	report.status = "failed"; report.error = String(error); process.exitCode = 1;
} finally {
	checkpoint(); writeSummary();
	console.log(`Saved ${path.join(import.meta.dir,"OHA_RESULTS.md")} (${report.status}); ${report.cells.length} measured cells`);
}
