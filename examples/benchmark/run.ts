import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TelemetrySnapshot } from "../shared/workload";

export interface ArtifactMetrics {
	readonly server: string;
	readonly deploymentModel:
		| "Lambda Web Function (nodejs24.x ZIP)"
		| "Classic Event Lambda + HTTP API Gateway (nodejs24.x ZIP)"
		| "Lambda Container Image (oven/bun:1.4.4-slim)";
	readonly bundleBytes: number;
	readonly bundleKb: number;
	readonly archiveBytes: number;
	readonly archiveKb: number;
	readonly containerImageMb?: number;
}

export interface ColdStartResult {
	readonly server: string;
	readonly deploymentModel: string;
	readonly trialsMs: number[];
	readonly medianColdStartMs: number;
	readonly meanColdStartMs: number;
	readonly warmP50Ms: number;
	readonly initReportDurationMs?: number;
	readonly initReportCpuMs?: number;
	readonly initReportMemoryMb?: number;
}

export interface ScenarioCellResult {
	readonly track: "bare-process" | "localstack-lambda" | "aws-lambda";
	readonly server: string;
	readonly scenario: string;
	readonly concurrency: number;
	readonly totalRequests: number;
	readonly errorCount: number;
	readonly durationMs: number;
	readonly rps: number;
	readonly p50Ms: number;
	readonly p90Ms: number;
	readonly p95Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
	readonly ttfbP50Ms?: number;
	readonly ttfbP95Ms?: number;
	readonly ttlbP50Ms?: number;
	readonly ttlbP95Ms?: number;
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly cpuTotalMs: number;
	readonly activeCpuMsPer1kReq: number;
	readonly peakRssMb: number;
	readonly peakHeapUsedMb: number;
	readonly uniqueSandboxes: number | null;
	readonly statusCounts: Record<string, number>;
}

export interface ContractProbeResult {
	readonly id: string;
	readonly name: string;
	readonly passed: boolean;
	readonly status: number;
	readonly errorTypeHeader?: string | null;
	readonly details: Record<string, unknown>;
}

export interface CloudWatchSummary {
	readonly functionName: string;
	readonly executedRequests: number;
	readonly status4xx: number;
	readonly responseBytes: number;
	readonly activeEnvironments: number;
	readonly maxConcurrentRequests: number;
	readonly initReports: Array<{
		readonly revisionId?: string;
		readonly totalDurationMs?: number;
		readonly totalCpuTimeMs?: number;
		readonly maxMemoryUsageMb?: number;
	}>;
}

export interface BenchmarkReportData {
	readonly generatedAt: string;
	readonly environment: {
		readonly hostArch: string;
		readonly nodeVersion: string;
		readonly bunVersion: string;
		readonly localstackVersion: string;
	};
	readonly endpoints: Record<string, string>;
	readonly artifacts: ArtifactMetrics[];
	readonly coldStarts: ColdStartResult[];
	readonly results: ScenarioCellResult[];
	readonly contractProbes: ContractProbeResult[];
	readonly cloudWatch: CloudWatchSummary[];
}

export const SERVERS = [
	"node-http",
	"express",
	"hono",
	"h3",
	"lambda-apigw",
	"bun-http",
] as const;
/** Track 1 runs local HTTP processes only; API Gateway is measured solely in the LocalStack track. */
export const BARE_TRACK_SERVERS = SERVERS.filter((server) => server !== "lambda-apigw");
const WEB_FUNCTION_SERVERS = ["node-http", "express", "hono", "h3"] as const;

const SMALL_JSON_BODY = JSON.stringify({
	items: Array.from({ length: 16 }, (_, i) => ({ id: i, name: `item-${i}`, active: true })),
	payload: "x".repeat(512),
});

const LARGE_JSON_BODY = JSON.stringify({
	items: Array.from({ length: 128 }, (_, i) => ({
		id: i,
		name: `record-${i}`,
		tags: ["lambda", "web-function", "benchmark"],
	})),
	payload: "A".repeat(48 * 1024),
});

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor((p / 100) * sorted.length)),
	);
	return Number(sorted[idx]!.toFixed(2));
}

export function measureArtifacts(): ArtifactMetrics[] {
	const workDir = mkdtempSync(path.join(tmpdir(), "bench-artifacts-"));
	try {
		const metrics: ArtifactMetrics[] = [];
		for (const srv of WEB_FUNCTION_SERVERS) {
			const entry = path.resolve(__dirname, "..", srv, "index.ts");
			const outDir = path.join(workDir, srv);
			mkdirSync(outDir, { recursive: true });
			const bundleFile = path.join(outDir, "index.js");
			const zipFile = path.join(outDir, "archive.zip");
			execFileSync("bun", ["build", entry, "--target=node", "--outfile", bundleFile]);
			execFileSync("zip", ["-q", zipFile, "index.js"], { cwd: outDir });
			const bundleBytes = statSync(bundleFile).size;
			const archiveBytes = statSync(zipFile).size;
			metrics.push({
				server: srv,
				deploymentModel: "Lambda Web Function (nodejs24.x ZIP)",
				bundleBytes,
				bundleKb: Number((bundleBytes / 1024).toFixed(2)),
				archiveBytes,
				archiveKb: Number((archiveBytes / 1024).toFixed(2)),
			});
		}

		// Measure Classic Event Lambda + HTTP API Gateway
		{
			const apigwEntry = path.resolve(__dirname, "..", "lambda-apigw", "index.ts");
			const apigwOutDir = path.join(workDir, "lambda-apigw");
			mkdirSync(apigwOutDir, { recursive: true });
			const apigwBundle = path.join(apigwOutDir, "index.js");
			const apigwZip = path.join(apigwOutDir, "archive.zip");
			execFileSync("bun", [
				"build",
				apigwEntry,
				"--target=node",
				"--format=cjs",
				"--outfile",
				apigwBundle,
			]);
			execFileSync("zip", ["-q", apigwZip, "index.js"], { cwd: apigwOutDir });
			const bundleBytes = statSync(apigwBundle).size;
			const archiveBytes = statSync(apigwZip).size;
			metrics.push({
				server: "lambda-apigw",
				deploymentModel: "Classic Event Lambda + HTTP API Gateway (nodejs24.x ZIP)",
				bundleBytes,
				bundleKb: Number((bundleBytes / 1024).toFixed(2)),
				archiveBytes,
				archiveKb: Number((archiveBytes / 1024).toFixed(2)),
			});
		}

		const bunEntry = path.resolve(__dirname, "..", "bun-http", "index.ts");
		const bunOutDir = path.join(workDir, "bun-http");
		mkdirSync(bunOutDir, { recursive: true });
		const bunBundle = path.join(bunOutDir, "index.js");
		execFileSync("bun", ["build", bunEntry, "--target=bun", "--outfile", bunBundle]);
		const bunBundleBytes = statSync(bunBundle).size;

		let imageBytes = 0;
		try {
			const imgOut = execFileSync("docker", [
				"images",
				"--format",
				"{{.Repository}}:{{.Tag}} {{.Size}}",
			]).toString("utf8");
			const inspectId = execFileSync("sh", [
				"-c",
				"docker images --filter 'reference=*cdkasset*' -q | head -n 1",
			])
				.toString("utf8")
				.trim();
			if (inspectId) {
				const rawSize = execFileSync("docker", [
					"image",
					"inspect",
					inspectId,
					"--format",
					"{{.Size}}",
				])
					.toString("utf8")
					.trim();
				imageBytes = Number(rawSize) || 0;
			}
			void imgOut;
		} catch {
			imageBytes = 0;
		}

		metrics.push({
			server: "bun-http",
			deploymentModel: "Lambda Container Image (oven/bun:1.4.4-slim)",
			bundleBytes: bunBundleBytes,
			bundleKb: Number((bunBundleBytes / 1024).toFixed(2)),
			archiveBytes: imageBytes || bunBundleBytes,
			archiveKb: Number((bunBundleBytes / 1024).toFixed(2)),
			containerImageMb: imageBytes
				? Number((imageBytes / (1024 * 1024)).toFixed(1))
				: undefined,
		});
		return metrics;
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

async function fetchTelemetry(
	baseUrl: string,
	reset = false,
): Promise<TelemetrySnapshot | null> {
	try {
		const res = await fetch(`${baseUrl}/__telemetry${reset ? "?reset=1" : ""}`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		return (await res.json()) as TelemetrySnapshot;
	} catch {
		return null;
	}
}

export interface ScenarioSpec {
	readonly id: string;
	readonly path: string;
	readonly method: "GET" | "POST";
	readonly body?: string;
	readonly headers?: Record<string, string>;
	readonly isStream?: boolean;
	readonly durationMs: number;
}

/** Root /ping is reserved by API Gateway's AWS service health handler. */
export function pingPath(server: string): string {
	return server === "lambda-apigw" ? "/healthz" : "/ping";
}

/** Validate unmeasured preflight responses; HTTP 200 alone is insufficient. */
export function validateWorkloadResponse(server: string, scenario: string, body: string): void {
	if (scenario === "stream-sse") {
		const frames = body.split("\n").filter((line) => line.startsWith("data: "));
		if (frames.length !== 8 || frames.some((frame) => JSON.parse(frame.slice(6)).server !== server)) {
			throw new Error(`${server}: invalid streaming workload response`);
		}
		return;
	}
	const parsed = JSON.parse(body);
	if (parsed.server !== server || parsed.ok !== true) {
		throw new Error(`${server}: response did not execute the expected ${scenario} workload`);
	}
	if (scenario === "async-io-30ms" && parsed.delayMs !== 30) throw new Error("I/O delay mismatch");
	if (scenario === "compute-sha256" && parsed.iterations !== 1500) throw new Error("Compute workload mismatch");
	if (scenario === "json-1kb" && (parsed.id !== "order-42" || parsed.itemCount !== 16)) throw new Error("Small JSON workload mismatch");
	if (scenario === "json-64kb" && (parsed.id !== "batch-99" || parsed.itemCount !== 128)) throw new Error("Large JSON workload mismatch");
}

export const SCENARIOS: ScenarioSpec[] = [
	{
		id: "ping",
		path: "/ping",
		method: "GET",
		durationMs: 1200,
	},
	{
		id: "json-1kb",
		path: "/json/order-42?mode=standard",
		method: "POST",
		body: SMALL_JSON_BODY,
		headers: { "content-type": "application/json" },
		durationMs: 1200,
	},
	{
		id: "json-64kb",
		path: "/json/batch-99?mode=bulk",
		method: "POST",
		body: LARGE_JSON_BODY,
		headers: { "content-type": "application/json" },
		durationMs: 1200,
	},
	{
		id: "async-io-30ms",
		path: "/io?delayMs=30",
		method: "GET",
		durationMs: 1200,
	},
	{
		id: "stream-sse",
		path: "/stream?chunks=8&intervalMs=5",
		method: "GET",
		isStream: true,
		durationMs: 1200,
	},
	{
		id: "compute-sha256",
		path: "/compute?iterations=1500",
		method: "POST",
		body: "benchmark-seed-payload",
		headers: { "content-type": "text/plain" },
		durationMs: 1200,
	},
];

export async function runScenarioCell(
	track: "bare-process" | "localstack-lambda" | "aws-lambda",
	server: string,
	baseUrl: string,
	scenario: ScenarioSpec,
	concurrency: number,
): Promise<ScenarioCellResult> {
	const targetUrl = `${baseUrl}${scenario.path}`;

	// Warm-up requests
	await Promise.all(
		Array.from({ length: Math.min(concurrency, 8) }, async () => {
			try {
				const r = await fetch(targetUrl, {
					method: scenario.method,
					headers: scenario.headers,
					body: scenario.body,
					signal: AbortSignal.timeout(15_000),
				});
				await r.arrayBuffer();
			} catch {}
		}),
	);

	// Reset in-sandbox telemetry baseline
	await fetchTelemetry(baseUrl, true);

	const latencies: number[] = [];
	const ttfbs: number[] = [];
	const ttlbs: number[] = [];
	const sandboxes = new Set<string>();
	const statusCounts: Record<string, number> = {};
	let errorCount = 0;

	const startWall = performance.now();
	const deadline = startWall + scenario.durationMs;

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (performance.now() < deadline) {
				const reqStart = performance.now();
				try {
					const res = await fetch(targetUrl, {
						method: scenario.method,
						headers: scenario.headers,
						body: scenario.body,
						signal: AbortSignal.timeout(15_000),
					});
					statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
					const logstream =
						res.headers.get("lambda-web-logstream") ??
						res.headers.get("x-lambda-request-id");
					if (logstream && res.headers.get("lambda-web-logstream")) {
						sandboxes.add(logstream);
					}
					if (!res.ok) {
						errorCount += 1;
						await res.arrayBuffer();
						continue;
					}

					if (scenario.isStream && res.body) {
						const reader = res.body.getReader();
						let firstChunkAt: number | null = null;
						while (true) {
							const { done } = await reader.read();
							if (firstChunkAt === null) {
								firstChunkAt = performance.now() - reqStart;
							}
							if (done) break;
						}
						const totalElapsed = performance.now() - reqStart;
						if (firstChunkAt !== null) ttfbs.push(firstChunkAt);
						ttlbs.push(totalElapsed);
						latencies.push(totalElapsed);
					} else {
						await res.arrayBuffer();
						latencies.push(performance.now() - reqStart);
					}
				} catch {
					errorCount += 1;
				}
			}
		}),
	);

	const elapsedMs = performance.now() - startWall;
	const telemetry = await fetchTelemetry(baseUrl, false);

	latencies.sort((a, b) => a - b);
	ttfbs.sort((a, b) => a - b);
	ttlbs.sort((a, b) => a - b);

	const totalRequests = latencies.length + errorCount;
	const rps = Number(((latencies.length / elapsedMs) * 1000).toFixed(1));
	const cpuUserMs = Number(((telemetry?.cpuUserUs ?? 0) / 1000).toFixed(2));
	const cpuSystemMs = Number(((telemetry?.cpuSystemUs ?? 0) / 1000).toFixed(2));
	const cpuTotalMs = Number((cpuUserMs + cpuSystemMs).toFixed(2));
	const activeCpuMsPer1kReq =
		latencies.length > 0
			? Number(((cpuTotalMs / latencies.length) * 1000).toFixed(2))
			: 0;

	return {
		track,
		server,
		scenario: scenario.id,
		concurrency,
		totalRequests,
		errorCount,
		durationMs: Number(elapsedMs.toFixed(1)),
		rps,
		p50Ms: percentile(latencies, 50),
		p90Ms: percentile(latencies, 90),
		p95Ms: percentile(latencies, 95),
		p99Ms: percentile(latencies, 99),
		maxMs: percentile(latencies, 100),
		ttfbP50Ms: scenario.isStream ? percentile(ttfbs, 50) : undefined,
		ttfbP95Ms: scenario.isStream ? percentile(ttfbs, 95) : undefined,
		ttlbP50Ms: scenario.isStream ? percentile(ttlbs, 50) : undefined,
		ttlbP95Ms: scenario.isStream ? percentile(ttlbs, 95) : undefined,
		cpuUserMs,
		cpuSystemMs,
		cpuTotalMs,
		activeCpuMsPer1kReq,
		peakRssMb: telemetry?.peakRssMb ?? 0,
		peakHeapUsedMb: telemetry?.peakHeapUsedMb ?? 0,
		uniqueSandboxes:
			sandboxes.size > 0 ? sandboxes.size : track === "aws-lambda" ? null : 1,
		statusCounts,
	};
}

export function startBareServer(srv: string, workDir: string, port: number): ReturnType<typeof spawn> {
	const hostAddr = `127.0.0.1:${port}`;
	const entryPath = path.resolve(__dirname, "..", srv, "index.ts");
	if (srv === "bun-http") {
		return spawn("bun", ["run", entryPath], {
			env: { ...process.env, AWS_LAMBDA_HTTP_ENDPOINT: hostAddr },
			stdio: "ignore",
		});
	}
	const outBundle = path.join(workDir, `${srv}.js`);
	execFileSync("bun", ["build", entryPath, "--target=node", "--outfile", outBundle]);
	return spawn("node", [outBundle], {
		env: { ...process.env, AWS_LAMBDA_HTTP_ENDPOINT: hostAddr },
		stdio: "ignore",
	});
}

export async function waitForBareServer(baseUrl: string): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const r = await fetch(`${baseUrl}/ping`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 50));
	}
}

export async function runBareProcessTrack(servers: readonly string[] = SERVERS): Promise<ScenarioCellResult[]> {
	const results: ScenarioCellResult[] = [];
	const workDir = mkdtempSync(path.join(tmpdir(), "bench-bare-"));

	try {
		for (let i = 0; i < servers.length; i++) {
			const srv = servers[i]!;
			const port = 4210 + i;
			const baseUrl = `http://127.0.0.1:${port}`;
			const child = startBareServer(srv, workDir, port);

			try {
				await waitForBareServer(baseUrl);

				for (const scenario of SCENARIOS) {
					const concurrencies =
						scenario.id === "ping" ||
						scenario.id === "json-1kb" ||
						scenario.id === "async-io-30ms"
							? [1, 16, 64]
							: [1, 16];
					for (const c of concurrencies) {
						console.log(
							`[Track 1: bare-process] ${srv} | ${scenario.id} | c=${c}`,
						);
						const cell = await runScenarioCell(
							"bare-process",
							srv,
							baseUrl,
							scenario,
							c,
						);
						results.push(cell);
					}
				}
			} finally {
				child.kill("SIGTERM");
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
	return results;
}

export function discoverLocalStackEndpoints(): Record<string, string> {
	const raw = execFileSync("docker", [
		"exec",
		"localstack-bench",
		"/opt/code/localstack/.venv/bin/python",
		"-c",
		`
import boto3, json
cf = boto3.client('cloudformation', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
stacks = {
    'node-http': 'NodeHttpStack',
    'express': 'ExpressStack',
    'hono': 'HonoStack',
    'h3': 'H3Stack',
    'lambda-apigw': 'LambdaApiGwStack',
    'bun-http': 'BunHttpStack',
}
out = {}
for k, sname in stacks.items():
    s = cf.describe_stacks(StackName=sname)['Stacks'][0]
    for o in s.get('Outputs', []):
        val = o['OutputValue']
        if 'localhost.localstack.cloud' in val:
            if not val.startswith('http'):
                val = 'http://' + val
            out[k] = val.rstrip('/')
print(json.dumps(out))
`,
	]).toString("utf8");
	return JSON.parse(raw.trim()) as Record<string, string>;
}

export function triggerColdStartRevision(server: string): void {
	if (server === "bun-http" || server === "lambda-apigw") {
		const fnName = `bench-${server}`;
		execFileSync("docker", [
			"exec",
			"localstack-bench",
			"/opt/code/localstack/.venv/bin/python",
			"-c",
			`
import boto3, time
lam = boto3.client('lambda', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
lam.update_function_configuration(
    FunctionName='${fnName}',
    Environment={'Variables': {'COLD_NONCE': str(time.time_ns())}}
)
for _ in range(40):
    state = lam.get_function_configuration(FunctionName='${fnName}').get('LastUpdateStatus')
    if state == 'Successful':
        break
    time.sleep(0.05)
`,
		]);
		return;
	}

	const fnName = `bench-${server}`;
	execFileSync("docker", [
		"exec",
		"localstack-bench",
		"/opt/code/localstack/.venv/bin/python",
		"-c",
		`
import boto3, time
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
fn = '${fnName}'
ep = client.get_web_function_endpoint(functionName=fn, endpointName='prod')
old_rev = client.get_web_function_revision(functionName=fn, revisionId=ep['revisionWeights'][0]['revisionId'])
svc_cfg = dict(old_rev['serviceConfig'])
env_vars = dict(svc_cfg.get('environmentVariables') or {})
env_vars['COLD_NONCE'] = str(time.time_ns())
svc_cfg['environmentVariables'] = env_vars
new_rev = client.create_web_function_revision(
    functionName=fn,
    buildConfig=old_rev['buildConfig'],
    serviceConfig=svc_cfg
)
new_rev_id = new_rev['revisionId']
while client.get_web_function_revision(functionName=fn, revisionId=new_rev_id)['state'] != 'Active':
    time.sleep(0.05)
client.update_web_function_endpoint(
    functionName=fn,
    endpointName='prod',
    revisionWeights=[{'revisionId': new_rev_id, 'weight': 100}]
)
while client.get_web_function_endpoint(functionName=fn, endpointName='prod').get('updateStatus') == 'InProgress':
    time.sleep(0.05)
`,
	]);
}

async function runColdStartTrials(
	endpoints: Record<string, string>,
	warmCells: ScenarioCellResult[],
): Promise<ColdStartResult[]> {
	const results: ColdStartResult[] = [];

	for (const srv of SERVERS) {
		const baseUrl = endpoints[srv]!;
		const trialsMs: number[] = [];

		for (let trial = 0; trial < 3; trial++) {
			triggerColdStartRevision(srv);
			const t0 = performance.now();
			const res = await fetch(`${baseUrl}/ping`);
			await res.arrayBuffer();
			const elapsed = Number((performance.now() - t0).toFixed(2));
			trialsMs.push(elapsed);
		}

		const sorted = [...trialsMs].sort((a, b) => a - b);
		const medianColdStartMs = sorted[1] ?? sorted[0] ?? 0;
		const meanColdStartMs = Number(
			(trialsMs.reduce((a, b) => a + b, 0) / trialsMs.length).toFixed(2),
		);
		const warmPing = warmCells.find(
			(c) =>
				c.track === "localstack-lambda" &&
				c.server === srv &&
				c.scenario === "ping" &&
				c.concurrency === 1,
		);

		results.push({
			server: srv,
			deploymentModel:
				srv === "bun-http"
					? "Lambda Container Image (Function URL)"
					: srv === "lambda-apigw"
						? "Classic Event Lambda + HTTP API Gateway (nodejs24.x)"
						: "Lambda Web Function (nodejs24.x)",
			trialsMs,
			medianColdStartMs,
			meanColdStartMs,
			warmP50Ms: warmPing?.p50Ms ?? 0,
		});
	}

	return results;
}

async function runContractProbes(
	endpoints: Record<string, string>,
): Promise<ContractProbeResult[]> {
	const nodeUrl = endpoints["node-http"]!;
	const probes: ContractProbeResult[] = [];

	// 1. Unsupported HTTP Method (TRACE -> 400 Platform.MalformedRequest)
	{
		const res = await fetch(`${nodeUrl}/ping`, { method: "TRACE" });
		const errType = res.headers.get("lambda-web-error-type");
		await res.text();
		probes.push({
			id: "unsupported-http-method",
			name: "Rejects unsupported HTTP method (TRACE) with 400 Platform.MalformedRequest",
			passed: res.status === 400 && errType === "Platform.MalformedRequest",
			status: res.status,
			errorTypeHeader: errType,
			details: { method: "TRACE", expectedStatus: 400 },
		});
	}

	// 2. Request & Response Header Contract (strips hop-by-hop & spoofed lambda-web-*, injects context headers)
	{
		const res = await fetch(`${nodeUrl}/headers`, {
			headers: {
				"lambda-web-request-id": "spoofed-request-id-123",
				"lambda-web-custom-spoof": "should-be-removed",
				"x-http-method-override": "DELETE",
				"x-real-ip": "10.99.99.99",
				"proxy-authorization": "Basic secret",
				"x-custom-allowed": "preserved-value",
			},
		});
		const respReqId = res.headers.get("lambda-web-request-id");
		const respLogstream = res.headers.get("lambda-web-logstream");
		const body = (await res.json()) as {
			headers: Record<string, string>;
			endpointEnv: string;
		};
		const received = body.headers;
		const passed =
			res.status === 200 &&
			Boolean(respReqId) &&
			respReqId !== "spoofed-request-id-123" &&
			received["lambda-web-request-id"] === respReqId &&
			received["lambda-web-endpoint-name"] === "prod" &&
			received["lambda-web-custom-spoof"] === undefined &&
			received["x-http-method-override"] === undefined &&
			received["x-real-ip"] === undefined &&
			received["proxy-authorization"] === undefined &&
			received["x-custom-allowed"] === "preserved-value" &&
			Boolean(respLogstream);

		probes.push({
			id: "header-sanitization-and-context",
			name: "Strips restricted/spoofed headers & injects lambda-web-request-id, lambda-web-endpoint-name, and lambda-web-logstream",
			passed,
			status: res.status,
			errorTypeHeader: res.headers.get("lambda-web-error-type"),
			details: {
				responseRequestId: respReqId,
				responseLogstream: respLogstream,
				endpointEnv: body.endpointEnv,
				receivedLambdaWebEndpointName: received["lambda-web-endpoint-name"],
				strippedSpoofedHeader: received["lambda-web-custom-spoof"] === undefined,
				strippedMethodOverride: received["x-http-method-override"] === undefined,
				strippedXRealIp: received["x-real-ip"] === undefined,
				preservedCustomHeader: received["x-custom-allowed"],
			},
		});
	}

	// 3. Endpoint Disabled via rateLimit = 0 (503 Platform.EndpointDisabled)
	{
		execFileSync("docker", [
			"exec",
			"localstack-bench",
			"/opt/code/localstack/.venv/bin/python",
			"-c",
			`
import boto3, time
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
client.update_web_function_endpoint(functionName='bench-node-http', endpointName='prod', throttleConfig={'rateLimit': 0})
while client.get_web_function_endpoint(functionName='bench-node-http', endpointName='prod').get('updateStatus') == 'InProgress':
    time.sleep(0.05)
`,
		]);

		const res = await fetch(`${nodeUrl}/ping`);
		const errType = res.headers.get("lambda-web-error-type");
		await res.text();

		probes.push({
			id: "endpoint-rate-limit-zero-disabled",
			name: "Blocks traffic when throttleConfig.rateLimit=0 with 503 Platform.EndpointDisabled",
			passed: res.status === 503 && errType === "Platform.EndpointDisabled",
			status: res.status,
			errorTypeHeader: errType,
			details: { configuredRateLimit: 0 },
		});
	}

	// 4. Endpoint Rate Throttling (429 Platform.EndpointRequestThrottle, rateLimit = 100)
	{
		execFileSync("docker", [
			"exec",
			"localstack-bench",
			"/opt/code/localstack/.venv/bin/python",
			"-c",
			`
import boto3, time
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
client.update_web_function_endpoint(functionName='bench-node-http', endpointName='prod', throttleConfig={'rateLimit': 100})
while client.get_web_function_endpoint(functionName='bench-node-http', endpointName='prod').get('updateStatus') == 'InProgress':
    time.sleep(0.05)
`,
		]);

		const burstResponses = await Promise.all(
			Array.from({ length: 160 }, async () => {
				const r = await fetch(`${nodeUrl}/ping`);
				await r.text();
				return {
					status: r.status,
					errorType: r.headers.get("lambda-web-error-type"),
				};
			}),
		);
		const throttled = burstResponses.filter(
			(r) =>
				r.status === 429 && r.errorType === "Platform.EndpointRequestThrottle",
		);

		probes.push({
			id: "endpoint-request-rate-throttle",
			name: "Enforces throttleConfig.rateLimit=100 under burst with 429 Platform.EndpointRequestThrottle",
			passed: throttled.length > 0,
			status: throttled[0]?.status ?? 200,
			errorTypeHeader: throttled[0]?.errorType ?? null,
			details: {
				configuredRateLimit: 100,
				burstSize: 160,
				throttled429Count: throttled.length,
				succeeded200Count: burstResponses.filter((r) => r.status === 200).length,
			},
		});
	}

	// 5. Max Environments Scaling & Throttling (429 Platform.EndpointMaxEnvThrottle + multi-sandbox logstreams)
	{
		execFileSync("docker", [
			"exec",
			"localstack-bench",
			"/opt/code/localstack/.venv/bin/python",
			"-c",
			`
import boto3, time
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
fn = 'bench-node-http'
ep = client.get_web_function_endpoint(functionName=fn, endpointName='prod')
old_rev = client.get_web_function_revision(functionName=fn, revisionId=ep['revisionWeights'][0]['revisionId'])
svc_cfg = dict(old_rev['serviceConfig'])
svc_cfg['maxConcurrencyPerEnvironment'] = 2
new_rev = client.create_web_function_revision(functionName=fn, buildConfig=old_rev['buildConfig'], serviceConfig=svc_cfg)
rev_id = new_rev['revisionId']
while client.get_web_function_revision(functionName=fn, revisionId=rev_id)['state'] != 'Active':
    time.sleep(0.05)
client.update_web_function_endpoint(
    functionName=fn,
    endpointName='prod',
    revisionWeights=[{'revisionId': rev_id, 'weight': 100}],
    scalingConfig={'maxEnvironments': 2},
    throttleConfig={}
)
while client.get_web_function_endpoint(functionName=fn, endpointName='prod').get('updateStatus') == 'InProgress':
    time.sleep(0.05)
`,
		]);

		const concurrentResponses = await Promise.all(
			Array.from({ length: 10 }, async () => {
				const r = await fetch(`${nodeUrl}/io?delayMs=250`);
				await r.text();
				return {
					status: r.status,
					errorType: r.headers.get("lambda-web-error-type"),
					logstream: r.headers.get("lambda-web-logstream"),
				};
			}),
		);

		const maxEnvThrottled = concurrentResponses.filter(
			(r) =>
				r.status === 429 && r.errorType === "Platform.EndpointMaxEnvThrottle",
		);
		const distinctLogstreams = new Set(
			concurrentResponses.map((r) => r.logstream).filter(Boolean),
		);

		probes.push({
			id: "endpoint-max-env-scale-and-throttle",
			name: "Scales up to scalingConfig.maxEnvironments=2 (with maxConcurrencyPerEnvironment=2) and throttles excess with 429 Platform.EndpointMaxEnvThrottle",
			passed: maxEnvThrottled.length > 0 && distinctLogstreams.size === 2,
			status: maxEnvThrottled[0]?.status ?? 200,
			errorTypeHeader: maxEnvThrottled[0]?.errorType ?? null,
			details: {
				maxEnvironments: 2,
				maxConcurrencyPerEnvironment: 2,
				concurrentRequestsSent: 10,
				distinctSandboxesObserved: distinctLogstreams.size,
				throttled429Count: maxEnvThrottled.length,
				succeeded200Count: concurrentResponses.filter((r) => r.status === 200)
					.length,
			},
		});

		// Restore bench-node-http to maxConcurrencyPerEnvironment=64 and unbounded scalingConfig
		execFileSync("docker", [
			"exec",
			"localstack-bench",
			"/opt/code/localstack/.venv/bin/python",
			"-c",
			`
import boto3, time
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
fn = 'bench-node-http'
ep = client.get_web_function_endpoint(functionName=fn, endpointName='prod')
old_rev = client.get_web_function_revision(functionName=fn, revisionId=ep['revisionWeights'][0]['revisionId'])
svc_cfg = dict(old_rev['serviceConfig'])
svc_cfg['maxConcurrencyPerEnvironment'] = 64
new_rev = client.create_web_function_revision(functionName=fn, buildConfig=old_rev['buildConfig'], serviceConfig=svc_cfg)
rev_id = new_rev['revisionId']
while client.get_web_function_revision(functionName=fn, revisionId=rev_id)['state'] != 'Active':
    time.sleep(0.05)
client.update_web_function_endpoint(
    functionName=fn,
    endpointName='prod',
    revisionWeights=[{'revisionId': rev_id, 'weight': 100}],
    scalingConfig={},
    throttleConfig={}
)
`,
		]);
	}

	return probes;
}

function collectCloudWatchTelemetry(): CloudWatchSummary[] {
	const raw = execFileSync("docker", [
		"exec",
		"localstack-bench",
		"/opt/code/localstack/.venv/bin/python",
		"-c",
		`
import boto3, json, datetime
cw = boto3.client('cloudwatch', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
logs = boto3.client('logs', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')

now = datetime.datetime.now(datetime.timezone.utc)
start = now - datetime.timedelta(hours=1)

def metric_stat(ns, name, dims, stat='Sum'):
    res = cw.get_metric_statistics(
        Namespace=ns,
        MetricName=name,
        Dimensions=dims,
        StartTime=start,
        EndTime=now + datetime.timedelta(minutes=5),
        Period=3600,
        Statistics=[stat]
    )
    pts = res.get('Datapoints', [])
    if not pts:
        return 0
    if stat == 'Sum':
        return sum(p.get('Sum', 0) for p in pts)
    return max(p.get('Maximum', 0) for p in pts)

out = []
for fn in ['bench-node-http', 'bench-express', 'bench-hono', 'bench-h3']:
    ep_dims = [{'Name': 'FunctionName', 'Value': fn}, {'Name': 'EndpointName', 'Value': 'prod'}]
    fn_dims = [{'Name': 'FunctionName', 'Value': fn}]
    reg_dims = [{'Name': 'FunctionName', 'Value': fn}, {'Name': 'EndpointName', 'Value': 'prod'}, {'Name': 'ExecutionRegion', 'Value': 'us-east-1'}]

    init_reports = []
    try:
        evts = logs.filter_log_events(logGroupName=f'/aws/lambda/web/{fn}.local', limit=100).get('events', [])
        last_rev = None
        for e in evts:
            msg = json.loads(e['message'])
            if msg.get('type') == 'platform.initStart':
                last_rev = msg.get('record', {}).get('revisionId')
            elif msg.get('type') == 'platform.initReport':
                m = msg.get('record', {}).get('metrics', {})
                init_reports.append({
                    'revisionId': last_rev,
                    'totalDurationMs': m.get('totalDurationMs'),
                    'totalCpuTimeMs': m.get('totalCpuTimeMs'),
                    'maxMemoryUsageMb': m.get('maxMemoryUsageMb'),
                })
    except Exception:
        pass

    out.append({
        'functionName': fn,
        'executedRequests': int(metric_stat('AWS/Lambda/Web', 'ExecutedRequests', ep_dims, 'Sum')),
        'status4xx': int(metric_stat('AWS/Lambda/Web', 'HTTPResponseStatusClass4XX', ep_dims, 'Sum')),
        'responseBytes': int(metric_stat('AWS/Lambda/Web', 'ResponseBytes', fn_dims, 'Sum')),
        'activeEnvironments': int(metric_stat('AWS/Lambda/Web/Usage', 'EndpointActiveEnvironments', reg_dims, 'Maximum')),
        'maxConcurrentRequests': int(metric_stat('AWS/Lambda/Web', 'EnvironmentConcurrentRequests', fn_dims, 'Maximum')),
        'initReports': init_reports,
    })

print(json.dumps(out))
`,
	]).toString("utf8");
	return JSON.parse(raw.trim()) as CloudWatchSummary[];
}

export function countEventLambdaContainers(server: string): number {
	const out = execFileSync("sh", [
		"-c",
		`docker ps --filter 'name=localstack-bench-lambda-bench-${server}' -q | wc -l`,
	])
		.toString("utf8")
		.trim();
	return Number(out) || 1;
}

async function main() {
	// Ensure bench-node-http endpoint has no leftover throttle/scaling limits
	execFileSync("docker", [
		"exec",
		"localstack-bench",
		"/opt/code/localstack/.venv/bin/python",
		"-c",
		`
import boto3
client = boto3.client('lambda-web', endpoint_url='http://localhost:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
client.update_web_function_endpoint(functionName='bench-node-http', endpointName='prod', scalingConfig={}, throttleConfig={})
`,
	]);
	console.log("1. Measuring deployment artifacts...");
	const artifacts = measureArtifacts();

	console.log("2. Discovering LocalStack deployed endpoints...");
	const endpoints = discoverLocalStackEndpoints();
	console.log("   Endpoints:", endpoints);

	console.log("3. Running Track 1 (Bare-Process Baseline on Host)...");
	const bareResults = await runBareProcessTrack(BARE_TRACK_SERVERS);

	console.log("4. Running Track 2 (LocalStack Lambda Sandbox)...");
	const lambdaResults: ScenarioCellResult[] = [];
	for (const srv of SERVERS) {
		const baseUrl = endpoints[srv]!;
		for (const scenario of SCENARIOS) {
			// For Web Functions: test c = 1, 16, 64 on key scenarios; for classic Event Functions (bun-http, lambda-apigw): c = 1, 8
			const isEventFn = srv === "bun-http" || srv === "lambda-apigw";
			const concurrencies = isEventFn
				? scenario.id === "ping" || scenario.id === "async-io-30ms"
					? [1, 8]
					: [1]
				: scenario.id === "ping" ||
						scenario.id === "json-1kb" ||
						scenario.id === "async-io-30ms"
					? [1, 16, 64]
					: [1, 16];

			for (const c of concurrencies) {
				console.log(
					`[Track 2: localstack-lambda] ${srv} | ${scenario.id} | c=${c}`,
				);
				const cell = await runScenarioCell(
					"localstack-lambda",
					srv,
					baseUrl,
					scenario,
					c,
				);
				if (isEventFn && c > 1) {
					const containerCount = countEventLambdaContainers(srv);
					lambdaResults.push({
						...cell,
						uniqueSandboxes: containerCount,
					});
				} else {
					lambdaResults.push(cell);
				}
			}
		}
	}

	const allResults = [...bareResults, ...lambdaResults];

	console.log("5. Running Cold-Start Trials (3 trials per server)...");
	const coldStarts = await runColdStartTrials(endpoints, allResults);

	console.log("6. Running Lambda Web Function Contract & Throttling Probes...");
	const contractProbes = await runContractProbes(endpoints);

	console.log("7. Collecting CloudWatch Metrics & System Init Logs...");
	const cloudWatch = collectCloudWatchTelemetry();

	// Attach initReport telemetry to coldStarts
	const enrichedColdStarts = coldStarts.map((cs) => {
		const cwEntry = cloudWatch.find(
			(cw) => cw.functionName === `bench-${cs.server}`,
		);
		const lastInit = cwEntry?.initReports.at(-1);
		return {
			...cs,
			initReportDurationMs: lastInit?.totalDurationMs,
			initReportCpuMs: lastInit?.totalCpuTimeMs,
			initReportMemoryMb: lastInit?.maxMemoryUsageMb,
		};
	});

	const reportData: BenchmarkReportData = {
		generatedAt: new Date().toISOString(),
		environment: {
			hostArch: `${process.platform}/${process.arch}`,
			nodeVersion: execFileSync("node", ["--version"]).toString("utf8").trim(),
			bunVersion: Bun.version,
			localstackVersion: "2026.10.4 (Pro / Ultimate)",
		},
		endpoints,
		artifacts,
		coldStarts: enrichedColdStarts,
		results: allResults,
		contractProbes,
		cloudWatch,
	};

	const resultsDir = path.resolve(__dirname, "results");
	mkdirSync(resultsDir, { recursive: true });
	const jsonPath = path.join(resultsDir, "latest.json");
	writeFileSync(jsonPath, JSON.stringify(reportData, null, 2));
	console.log(`Saved raw benchmark data to ${jsonPath}`);
}

if (import.meta.main) {
	await main();
}
