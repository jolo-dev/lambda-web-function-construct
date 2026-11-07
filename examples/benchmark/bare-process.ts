import { cpus } from "node:os";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runBareProcessTrack, SCENARIOS, type ScenarioCellResult } from "./run";

export const BARE_PROCESS_SERVERS = ["node-http", "express", "hono", "h3", "bun-http"] as const;

export interface BareProcessReport {
	schemaVersion: 1;
	track: "bare-process";
	startedAt: string;
	finishedAt: string;
	host: { platform: string; arch: string; cpuModel: string; logicalCpus: number; node: string; bun: string };
	servers: readonly string[];
	scenarios: readonly string[];
	results: ScenarioCellResult[];
}

export async function runBareProcessBenchmark(): Promise<BareProcessReport> {
	const startedAt = new Date().toISOString();
	const results = await runBareProcessTrack(BARE_PROCESS_SERVERS);
	const cpu = cpus()[0];
	return {
		schemaVersion: 1,
		track: "bare-process",
		startedAt,
		finishedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			arch: process.arch,
			cpuModel: cpu?.model ?? "unknown",
			logicalCpus: cpus().length,
			node: process.version,
			bun: Bun.version,
		},
		servers: BARE_PROCESS_SERVERS,
		scenarios: SCENARIOS.map(({ id }) => id),
		results,
	};
}

if (import.meta.main) {
	const report = await runBareProcessBenchmark();
	const resultsDirectory = path.resolve(import.meta.dir, "results");
	mkdirSync(resultsDirectory, { recursive: true });
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	const timestamp = report.startedAt.replace(/[:.]/g, "-");
	const archive = path.join(resultsDirectory, `bare-process-${timestamp}.json`);
	const latest = path.join(resultsDirectory, "bare-process-latest.json");
	writeFileSync(archive, serialized);
	writeFileSync(latest, serialized);
	console.log(`Saved bare-process results to ${latest} and ${archive}`);
	console.table(report.results.map(({ server, scenario, concurrency, rps, p50Ms, p95Ms, errorCount }) => ({
		server, scenario, concurrency, rps, p50Ms, p95Ms, errors: errorCount,
	})));
}
