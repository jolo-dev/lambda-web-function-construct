import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS, runScenarioCell, pingPath, validateWorkloadResponse, type ScenarioCellResult } from "./run";
import { archiveLogs } from "./telemetry-artifacts";

const SERVERS = ["node-http", "express", "hono", "h3", "bun-http", "lambda-apigw"];
const args = parseArgs({ options: {
	profile: { type: "string" }, region: { type: "string" },
	duration: { type: "string", default: "2000" }, repeats: { type: "string", default: "2" },
	"reuse-cold": { type: "string" }, "max-environments": { type: "string", default: "8" },
} }).values;
if (!args.profile || !args.region) throw new Error("Supply --profile and --region explicitly");
const durationMs = Number(args.duration);
const repeats = Number(args.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || durationMs < 500 || durationMs > 10_000) {
	throw new Error("Bounded run requires 1–3 repeats and 500–10000 ms per cell");
}
const maxEnvironments = Number(args["max-environments"]);
if (!Number.isInteger(maxEnvironments) || maxEnvironments < 2 || maxEnvironments > 16) throw new Error("Use 2–16 environments per benchmark Web endpoint");
const startedAt = new Date().toISOString();
const resultsDir = path.join(import.meta.dir, "results");
mkdirSync(resultsDir, { recursive: true });
const runId = startedAt.replace(/[:.]/g, "-");
const output = path.join(resultsDir, `aws-${args.region}-${runId}.json`);
const python = process.env.BENCH_PYTHON ?? "python3";
function control(action: string, value?: string, input?: unknown): any {
	return JSON.parse(execFileSync(python, [path.join(import.meta.dir, "aws-control.py"),
		"--profile", args.profile!, "--region", args.region!, action, ...(value ? [value] : [])], {
		encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input),
		timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, AWS_ENDPOINT_URL: undefined, AWS_ENDPOINT_URL_LAMBDA: undefined },
	}));
}
const reusedColdStarts = args["reuse-cold"]
	? JSON.parse(readFileSync(args["reuse-cold"], "utf8")).coldStarts.filter((entry: any) => {
		try {
			if (entry.trials.length !== 3) return false;
			for (const trial of entry.trials) {
				if (trial.status !== 200) return false;
				validateWorkloadResponse(entry.server, "ping", trial.body);
				if (trial.revisionId && !trial.headers["lambda-web-logstream"]?.includes(`[${trial.revisionId}]`)) return false;
			}
			return true;
		} catch { return false; }
	}) : [];
const snapshot = control("snapshot");
writeFileSync(path.join(resultsDir, `aws-snapshot-${runId}.json`), JSON.stringify(snapshot, null, 2));
const report = {
	startedAt, generatedAt: startedAt, status: "running", profile: args.profile, region: args.region,
	loadGenerator: { location: "operator host, outside AWS", platform: `${process.platform}/${process.arch}`, runtime: `bun/${Bun.version}` },
	methodology: {
		durationMs, repeats, timeoutMs: 15000,
		concurrencies: "Same for every candidate: ping/I/O at 1,8,16,64; other routes at 1,16",
		telemetryCaveat: "Process telemetry is one sampled sandbox, NOT an aggregate or AWS billing data. Null sandbox count means not observable from response headers.",
		coldStartCaveat: "Three first-request timings after revision/configuration replacement. Includes network and routing; verify platform init logs, not a guaranteed on-demand cold start.",
	},
	endpoints: snapshot.endpoints as Record<string, string>,
	configuration: snapshot.configuration, accountQuotas: snapshot.accountQuotas,
	benchmarkMaxEnvironments: maxEnvironments,
	coldStartSource: args["reuse-cold"] ?? null,
	coldStarts: reusedColdStarts as any[],
	warmupFailures: [] as any[], results: [] as (ScenarioCellResult & { repeat: number; startedAt: string; endedAt: string })[],
	contractProbes: [] as any[], telemetry: null as any, restoration: null as any, failure: null as string | null,
};
function save() {
	report.generatedAt = new Date().toISOString();
	writeFileSync(output, JSON.stringify(report, null, 2));
	writeFileSync(path.join(resultsDir, "aws-latest.json"), JSON.stringify(report, null, 2));
}
async function request(url: string, init?: RequestInit) {
	const t = performance.now();
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
	const body = await response.text();
	return { status: response.status, elapsedMs: Number((performance.now()-t).toFixed(2)), headers: Object.fromEntries(response.headers), body };
}
save();
try {
	for (const server of SERVERS.filter((s) => !["bun-http", "lambda-apigw"].includes(s))) {
		control("update-endpoint", server, { scalingConfig: { maxEnvironments } });
	}
	// Verify application semantics: API Gateway's reserved /ping returns 200 without invoking Lambda.
	for (const server of SERVERS) {
		for (const spec of SCENARIOS) {
			const preflight = await request(`${report.endpoints[server]}${spec.id === "ping" ? pingPath(server) : spec.path}`, {
				method: spec.method, headers: spec.headers, body: spec.body,
			});
			if (preflight.status !== 200) throw new Error(`${server} preflight HTTP ${preflight.status}`);
			validateWorkloadResponse(server, spec.id, preflight.body);
		}
	}
	for (const server of SERVERS) {
		if (report.coldStarts.some((c: any) => c.server === server)) continue;
		console.log(`Cold-start replacements: ${server}`);
		const trials = [];
		for (let trial = 0; trial < 3; trial++) {
			const replacement = control("cold", server);
			const propagationResponses = [];
			let first = await request(`${report.endpoints[server]}${pingPath(server)}`);
			while (replacement.revisionId && !first.headers["lambda-web-logstream"]?.includes(`[${replacement.revisionId}]`)) {
				propagationResponses.push(first);
				if (propagationResponses.length >= 30) throw new Error(`${server}: data plane did not route to the new revision`);
				await Bun.sleep(1000);
				first = await request(`${report.endpoints[server]}${pingPath(server)}`);
			}
			if (first.status !== 200) throw new Error(`${server} first request: ${JSON.stringify(first)}`);
			validateWorkloadResponse(server, "ping", first.body);
			trials.push({ ...replacement, ...first, propagationResponses });
			console.log(`  trial ${trial+1}: ${first.elapsedMs} ms, logstream=${first.headers["lambda-web-logstream"] ?? "not exposed"}`);
		}
		report.coldStarts.push({ server, trials });
		save();
	}

	for (let repeat = 1; repeat <= repeats; repeat++) {
		// Reverse server order in repeat 2 to reduce ordering bias.
		for (const server of repeat % 2 ? SERVERS : [...SERVERS].reverse()) {
			for (const spec of SCENARIOS) {
				const concurrencies = ["ping", "async-io-30ms"].includes(spec.id) ? [1, 8, 16, 64] : [1, 16];
				for (const concurrency of concurrencies) {
					// Warm all intended concurrent slots, not only eight, before timing.
					await Promise.all(Array.from({ length: concurrency }, async () => {
						const warm = await request(`${report.endpoints[server]}/io?delayMs=100`);
						if (warm.status !== 200) report.warmupFailures.push({ server, scenario: spec.id, concurrency, repeat, ...warm });
					}));
					const cellStartedAt = new Date().toISOString();
					const cell = await runScenarioCell("aws-lambda", server, report.endpoints[server]!, { ...spec, path: spec.id === "ping" ? pingPath(server) : spec.path, durationMs }, concurrency);
					report.results.push({ ...cell, repeat, startedAt: cellStartedAt, endedAt: new Date().toISOString() });
					console.log(`[AWS repeat=${repeat}] ${server} ${spec.id} c=${concurrency}: ${cell.rps} RPS, p50=${cell.p50Ms}ms, errors=${cell.errorCount}, sandboxes=${cell.uniqueSandboxes ?? "unknown"}`);
					save();
				}
			}
		}
	}

	const nodeUrl = report.endpoints["node-http"]!;
	const trace = await request(`${nodeUrl}/ping`, { method: "TRACE" });
	report.contractProbes.push({ id: "unsupported-http-method", ...trace });
	const headers = await request(`${nodeUrl}/headers`, { headers: {
		"lambda-web-request-id": "spoofed-request-id-123", "lambda-web-custom-spoof": "should-be-removed",
		"x-http-method-override": "DELETE", "x-real-ip": "10.99.99.99", "proxy-authorization": "Basic benchmark-not-a-secret", "x-custom-allowed": "preserved-value",
	} });
	report.contractProbes.push({ id: "header-sanitization-and-context", ...headers });
	control("update-endpoint", undefined, { throttleConfig: { rateLimit: 0 } });
	report.contractProbes.push({ id: "endpoint-rate-limit-zero-disabled", ...await request(`${nodeUrl}/ping`) });
	control("update-endpoint", undefined, { throttleConfig: { rateLimit: 100 } });
	const burst = await Promise.all(Array.from({ length: 160 }, () => request(`${nodeUrl}/ping`)));
	report.contractProbes.push({ id: "endpoint-request-rate-throttle", burst });
	report.status = "complete";
} catch (error) {
	report.status = "failed";
	report.failure = error instanceof Error ? error.stack! : String(error);
	throw error;
} finally {
	try {
		report.restoration = control("restore", undefined, snapshot);
	} finally {
		save();
	}
}
// Allow CloudWatch publication lag; billed metrics remain separate from process samples.
console.log("Collecting CloudWatch logs and metrics after publication delay...");
await Bun.sleep(65_000);
const telemetryStart = report.coldStartSource ? JSON.parse(readFileSync(report.coldStartSource, "utf8")).startedAt : startedAt;
report.telemetry = archiveLogs(control("telemetry", telemetryStart), resultsDir, runId);
save();
console.log(`Saved AWS benchmark: ${output}`);
