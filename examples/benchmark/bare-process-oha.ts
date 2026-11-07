import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildOhaArgs, parseOhaResult, type OhaResult } from "./oha";
import { BARE_PROCESS_SERVERS } from "./bare-process";
import { SCENARIOS, startBareServer, waitForBareServer, type ScenarioSpec } from "./run";

const execFileAsync = promisify(execFile);

export interface BareOhaCell extends OhaResult {
	server: string;
	scenario: string;
	concurrency: number;
}

export interface BareOhaReport {
	schemaVersion: 1;
	track: "bare-process";
	generator: { tool: "oha"; version: string };
	startedAt: string;
	finishedAt: string;
	warmupSeconds: number;
	measureSeconds: number;
	host: { platform: string; arch: string; cpuModel: string; logicalCpus: number; node: string; bun: string };
	servers: readonly string[];
	cells: BareOhaCell[];
}

/** Same concurrency matrix as the built-in bare-process runner. */
export function concurrenciesFor(scenarioId: string): number[] {
	return scenarioId === "ping" || scenarioId === "json-1kb" || scenarioId === "async-io-30ms" ? [1, 16, 64] : [1, 16];
}

export function bareOhaCells(): { server: string; scenario: string; concurrency: number }[] {
	return BARE_PROCESS_SERVERS.flatMap((server) =>
		SCENARIOS.flatMap((scenario) =>
			concurrenciesFor(scenario.id).map((concurrency) => ({ server, scenario: scenario.id, concurrency })),
		),
	);
}

/** oha arguments for one workload. Request method, body and content type are inserted before the URL. */
export function bareOhaArgs(scenario: ScenarioSpec, url: string, concurrency: number, seconds: number): string[] {
	const args = buildOhaArgs(url, concurrency, seconds);
	const extra: string[] = [];
	if (scenario.method !== "GET") extra.push("-m", scenario.method);
	if (scenario.body !== undefined) extra.push("-d", scenario.body);
	const contentType = scenario.headers?.["content-type"];
	if (contentType) extra.push("-T", contentType);
	args.splice(args.length - 1, 0, ...extra);
	return args;
}

async function runOha(args: string[]): Promise<unknown> {
	const { stdout } = await execFileAsync("oha", args, { maxBuffer: 256 * 1024 * 1024 });
	return JSON.parse(stdout);
}

export async function runBareOhaBenchmark(options = { warmupSeconds: 2, measureSeconds: 5 }): Promise<BareOhaReport> {
	const startedAt = new Date().toISOString();
	const { stdout: version } = await execFileAsync("oha", ["--version"]);
	const workDir = mkdtempSync(path.join(tmpdir(), "bench-bare-oha-"));
	const cells: BareOhaCell[] = [];

	try {
		for (const [index, server] of BARE_PROCESS_SERVERS.entries()) {
			const port = 4310 + index;
			const baseUrl = `http://127.0.0.1:${port}`;
			const child = startBareServer(server, workDir, port);
			try {
				await waitForBareServer(baseUrl);
				for (const scenario of SCENARIOS) {
					for (const concurrency of concurrenciesFor(scenario.id)) {
						const url = `${baseUrl}${scenario.path}`;
						console.log(`[Track 1 oha: bare-process] ${server} | ${scenario.id} | c=${concurrency}`);
						// Warm-up output is discarded; only the measured run is kept.
						await runOha(bareOhaArgs(scenario, url, concurrency, options.warmupSeconds));
						const raw = await runOha(bareOhaArgs(scenario, url, concurrency, options.measureSeconds));
						cells.push({ server, scenario: scenario.id, concurrency, ...parseOhaResult(raw) });
					}
				}
			} finally {
				child.kill("SIGTERM");
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	const cpu = cpus()[0];
	return {
		schemaVersion: 1,
		track: "bare-process",
		generator: { tool: "oha", version: version.trim() },
		startedAt,
		finishedAt: new Date().toISOString(),
		warmupSeconds: options.warmupSeconds,
		measureSeconds: options.measureSeconds,
		host: {
			platform: process.platform,
			arch: process.arch,
			cpuModel: cpu?.model ?? "unknown",
			logicalCpus: cpus().length,
			node: process.version,
			bun: Bun.version,
		},
		servers: BARE_PROCESS_SERVERS,
		cells,
	};
}

if (import.meta.main) {
	const report = await runBareOhaBenchmark();
	const resultsDirectory = path.resolve(import.meta.dir, "results");
	mkdirSync(resultsDirectory, { recursive: true });
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	const timestamp = report.startedAt.replace(/[:.]/g, "-");
	const archive = path.join(resultsDirectory, `bare-process-oha-${timestamp}.json`);
	const latest = path.join(resultsDirectory, "bare-process-oha-latest.json");
	writeFileSync(archive, serialized);
	writeFileSync(latest, serialized);
	console.log(`Saved bare-process oha results to ${latest} and ${archive}`);
	console.table(
		report.cells.map((c) => ({
			server: c.server,
			scenario: c.scenario,
			c: c.concurrency,
			successfulRps: Math.round(c.successfulRps),
			p50Ms: c.p50Ms,
			p95Ms: c.p95Ms,
			errors: c.httpFailures + c.transportErrors,
		})),
	);
}
