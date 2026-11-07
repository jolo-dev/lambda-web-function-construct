import { isIPv4 } from "node:net";

export function parseAwsCliOutput(output: string, emptyIsValid = false): any {
	if (!output.trim() && emptyIsValid) return {};
	return JSON.parse(output);
}
export function stableJson(value: unknown): string {
	function sort(input: any): any {
		if (Array.isArray(input)) return input.map(sort);
		if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map(key=>[key,sort(input[key])]));
		return input;
	}
	return JSON.stringify(sort(value));
}

export function buildOhaArgs(url: string, concurrency: number, durationSeconds: number, addresses?: string[]): string[] {
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error("Concurrency must be 1–128");
	if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 120) throw new Error("Duration must be 1–120 seconds");
	const target = new URL(url);
	if (!["http:", "https:"].includes(target.protocol)) throw new Error("Use HTTP or HTTPS");
	const port = target.port || (target.protocol === "https:" ? "443" : "80");
	if (addresses && (!addresses.length || addresses.some(ip=>!isIPv4(ip)))) throw new Error("Expected resolved IPv4 addresses");
	const connections = (addresses ?? []).flatMap(ip=>["--connect-to", `${target.hostname}:${port}:${ip}:${port}`]);
	return ["--no-tui", "--no-color", "--http-version", "1.1", "--disable-compression",
		"--stats-success-breakdown", "--wait-ongoing-requests-after-deadline",
		"-t", "15s", "--connect-timeout", "5s", "-c", String(concurrency), "-z", `${durationSeconds}s`,
		"--output-format", "json", ...connections, url];
}

export interface OhaResult {
	totalSeconds: number;
	successfulRequests: number;
	httpFailures: number;
	transportErrors: number;
	totalAttempts: number;
	successfulRps: number;
	failureRate: number;
	p50Ms: number | null;
	p95Ms: number | null;
	p99Ms: number | null;
	statusCounts: Record<string, number>;
}
function counts(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing oha count distribution");
	for (const count of Object.values(value)) {
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("Invalid oha count");
	}
	return value as Record<string, number>;
}
/** oha's summary.successRate counts received HTTP errors as completed requests. */
export function parseOhaResult(raw: any): OhaResult {
	const totalSeconds = raw.summary?.total;
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) throw new Error("Invalid oha duration");
	const statusCounts = counts(raw.statusCodeDistribution);
	const transportErrors = Object.values(counts(raw.errorDistribution)).reduce((a, b) => a+b, 0);
	let successfulRequests = 0, httpFailures = 0;
	for (const [status, count] of Object.entries(statusCounts)) {
		if (!/^[1-5][0-9]{2}$/.test(status)) throw new Error("Invalid HTTP status");
		if (Number(status) >= 200 && Number(status) < 300) successfulRequests += count;
		else httpFailures += count;
	}
	const totalAttempts = successfulRequests+httpFailures+transportErrors;
	function percentile(name: string): number | null {
		if (!successfulRequests) return null;
		const value = raw.latencyPercentilesSuccessful?.[name];
		if (!Number.isFinite(value) || value < 0) throw new Error("Missing success latency; use --stats-success-breakdown");
		return value*1000;
	}
	return { totalSeconds, successfulRequests, httpFailures, transportErrors, totalAttempts,
		successfulRps: successfulRequests/totalSeconds,
		failureRate: totalAttempts ? (httpFailures+transportErrors)/totalAttempts : 0,
		p50Ms: percentile("p50"), p95Ms: percentile("p95"), p99Ms: percentile("p99"), statusCounts };
}
export interface OhaCell extends OhaResult { server: string; concurrency: number }
function median(values: number[]): number | null {
	if (!values.length) return null;
	values.sort((a,b)=>a-b);
	const i = Math.floor(values.length/2);
	return values.length%2 ? values[i] : (values[i-1]+values[i])/2;
}
export function summarizeOhaCells(cells: OhaCell[]) {
	const groups = new Map<string, OhaCell[]>();
	for (const cell of cells) {
		const key = `${cell.server}:${cell.concurrency}`;
		groups.set(key, [...(groups.get(key) ?? []), cell]);
	}
	return [...groups.values()].map((runs) => {
		const sum = (field: "totalSeconds" | "successfulRequests" | "httpFailures" | "transportErrors" | "totalAttempts") => runs.reduce((n,r)=>n+r[field],0);
		const totalSeconds = sum("totalSeconds"), successfulRequests = sum("successfulRequests"), totalAttempts = sum("totalAttempts");
		const httpFailures = sum("httpFailures"), transportErrors = sum("transportErrors");
		const percentile = (field: "p50Ms" | "p95Ms" | "p99Ms") => median(runs.map(r=>r[field]).filter((n): n is number => n !== null));
		return { server: runs[0].server, concurrency: runs[0].concurrency, repeats: runs.length,
			totalSeconds, successfulRequests, totalAttempts, httpFailures, transportErrors,
			successfulRps: successfulRequests/totalSeconds, failureRate: totalAttempts ? (httpFailures+transportErrors)/totalAttempts : 0,
			p50Ms: percentile("p50Ms"), p95Ms: percentile("p95Ms"), p99Ms: percentile("p99Ms"),
			rpsRange: [Math.min(...runs.map(r=>r.successfulRps)), Math.max(...runs.map(r=>r.successfulRps))],
		};
	});
}
