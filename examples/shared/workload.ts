import { createHash } from "node:crypto";

export interface ListenEndpoint {
	readonly host: string;
	readonly port: number;
}

export function parseListenEndpoint(
	defaultAddress = "127.0.0.1:3000",
): ListenEndpoint {
	const raw = process.env.AWS_LAMBDA_HTTP_ENDPOINT || defaultAddress;
	const lastColon = raw.lastIndexOf(":");
	if (lastColon === -1) {
		return { host: "127.0.0.1", port: Number(raw) || 3000 };
	}
	const host = raw.slice(0, lastColon) || "127.0.0.1";
	const port = Number(raw.slice(lastColon + 1)) || 3000;
	return { host, port };
}

let windowCpuBaseline = process.cpuUsage();
let windowStartNs = process.hrtime.bigint();
let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
let requestsInWindow = 0;

export function recordRequestSample(): void {
	requestsInWindow += 1;
	if ((requestsInWindow & 15) === 0) {
		const mem = process.memoryUsage();
		if (mem.rss > peakRssBytes) peakRssBytes = mem.rss;
		if (mem.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = mem.heapUsed;
	}
}

export interface TelemetrySnapshot {
	readonly server: string;
	readonly runtime: string;
	readonly pid: number;
	readonly requestsInWindow: number;
	readonly cpuUserUs: number;
	readonly cpuSystemUs: number;
	readonly cpuTotalMs: number;
	readonly windowWallMs: number;
	readonly rssBytes: number;
	readonly heapUsedBytes: number;
	readonly heapTotalBytes: number;
	readonly peakRssBytes: number;
	readonly peakHeapUsedBytes: number;
	readonly rssMb: number;
	readonly peakRssMb: number;
	readonly heapUsedMb: number;
	readonly peakHeapUsedMb: number;
}

export function takeTelemetrySnapshot(
	serverName: string,
	reset = false,
): TelemetrySnapshot {
	const deltaCpu = process.cpuUsage(windowCpuBaseline);
	const nowNs = process.hrtime.bigint();
	const windowWallMs = Number(nowNs - windowStartNs) / 1_000_000;
	const mem = process.memoryUsage();
	if (mem.rss > peakRssBytes) peakRssBytes = mem.rss;
	if (mem.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = mem.heapUsed;

	const snapshot: TelemetrySnapshot = {
		server: serverName,
		runtime:
			typeof globalThis.Bun !== "undefined"
				? `bun/${globalThis.Bun.version}`
				: `node/${process.versions.node}`,
		pid: process.pid,
		requestsInWindow,
		cpuUserUs: deltaCpu.user,
		cpuSystemUs: deltaCpu.system,
		cpuTotalMs: Number(((deltaCpu.user + deltaCpu.system) / 1000).toFixed(3)),
		windowWallMs: Number(windowWallMs.toFixed(3)),
		rssBytes: mem.rss,
		heapUsedBytes: mem.heapUsed,
		heapTotalBytes: mem.heapTotal,
		peakRssBytes,
		peakHeapUsedBytes,
		rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
		peakRssMb: Number((peakRssBytes / (1024 * 1024)).toFixed(2)),
		heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
		peakHeapUsedMb: Number((peakHeapUsedBytes / (1024 * 1024)).toFixed(2)),
	};

	if (reset) {
		windowCpuBaseline = process.cpuUsage();
		windowStartNs = process.hrtime.bigint();
		peakRssBytes = mem.rss;
		peakHeapUsedBytes = mem.heapUsed;
		requestsInWindow = 0;
	}

	return snapshot;
}

export function processJsonPayload(
	serverName: string,
	id: string,
	mode: string,
	body: unknown,
) {
	recordRequestSample();
	const record =
		typeof body === "object" && body !== null
			? (body as Record<string, unknown>)
			: {};
	const items = Array.isArray(record.items) ? record.items.length : 0;
	const payloadText = typeof record.payload === "string" ? record.payload : "";
	let checksum = 0;
	for (let i = 0; i < payloadText.length; i += 64) {
		checksum = (checksum * 31 + payloadText.charCodeAt(i)) >>> 0;
	}
	return {
		ok: true,
		server: serverName,
		id,
		mode,
		itemCount: items,
		payloadLength: payloadText.length,
		checksum,
	};
}

export function runComputeIterations(
	serverName: string,
	iterationsRaw: number,
	seed = "lambda-web-function-benchmark",
) {
	recordRequestSample();
	const iterations = Math.max(
		1,
		Math.min(50_000, Math.floor(iterationsRaw || 1000)),
	);
	let digest = seed;
	for (let i = 0; i < iterations; i++) {
		digest = createHash("sha256").update(digest).update(String(i)).digest("hex");
	}
	return {
		ok: true,
		server: serverName,
		iterations,
		digest: digest.slice(0, 16),
	};
}

export function clampInt(
	value: string | null | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (Number.isNaN(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
