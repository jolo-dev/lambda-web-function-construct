export interface Cell {
	server: string;
	scenario: string;
	concurrency: number;
	totalRequests: number;
	errorCount: number;
	durationMs: number;
	rps: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	ttfbP50Ms?: number;
	ttlbP50Ms?: number;
	uniqueSandboxes: number | null;
}

export function median(values: number[]): number {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle-1]! + sorted[middle]!) / 2;
}

export function summarizeCells(cells: Cell[]) {
	const groups = new Map<string, Cell[]>();
	for (const cell of cells) {
		const key = `${cell.server}/${cell.scenario}/${cell.concurrency}`;
		groups.set(key, [...(groups.get(key) ?? []), cell]);
	}
	return [...groups.values()].map((group) => {
		const first = group[0]!;
		const totalRequests = group.reduce((n, c) => n+c.totalRequests, 0);
		const errorCount = group.reduce((n, c) => n+c.errorCount, 0);
		const durationMs = group.reduce((n, c) => n+c.durationMs, 0);
		return {
			server: first.server, scenario: first.scenario, concurrency: first.concurrency,
			totalRequests, errorCount, repeats: group.length,
			rps: (totalRequests-errorCount) / durationMs * 1000,
			p50Ms: median(group.map((c) => c.p50Ms)),
			p95Ms: median(group.map((c) => c.p95Ms)),
			p99Ms: median(group.map((c) => c.p99Ms)),
			ttfbP50Ms: median(group.flatMap((c) => c.ttfbP50Ms === undefined ? [] : [c.ttfbP50Ms])),
			ttlbP50Ms: median(group.flatMap((c) => c.ttlbP50Ms === undefined ? [] : [c.ttlbP50Ms])),
			rpsRange: [Math.min(...group.map((c) => c.rps)), Math.max(...group.map((c) => c.rps))],
			p50Range: [Math.min(...group.map((c) => c.p50Ms)), Math.max(...group.map((c) => c.p50Ms))],
			sandboxCounts: group.map((c) => c.uniqueSandboxes),
		};
	});
}

export function parseClassicInit(report: string): { totalDurationMs: number; maxMemoryUsageMb: number } {
	return {
		totalDurationMs: Number(report.match(/Init Duration: ([0-9.]+) ms/)?.[1]),
		maxMemoryUsageMb: Number(report.match(/Max Memory Used: ([0-9.]+) MB/)?.[1]),
	};
}

interface ColdTrial {
	revisionId?: string;
	elapsedMs: number;
	headers: Record<string, string>;
}
export function verifiedColdTrials<T extends ColdTrial>(trials: T[]): T[] {
	return trials.filter((trial) => !trial.revisionId || trial.headers["lambda-web-logstream"]?.includes(`[${trial.revisionId}]`));
}
