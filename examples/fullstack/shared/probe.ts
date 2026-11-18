import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/*
 * Smoke-test support for the fullstack examples. A launcher under test must:
 *   - listen on the host:port in AWS_LAMBDA_HTTP_ENDPOINT (port 0 means "choose one");
 *   - print `READY:<port>` on stdout after binding;
 *   - answer GET /__probe/identity with JSON { "marker", "port" }, where marker is FULLSTACK_PROBE_MARKER.
 * The marker is random per start, so an unrelated server on the same port cannot satisfy the probe.
 */

const IDENTITY_PATH = "/__probe/identity";
const MARKER_ENV = "FULLSTACK_PROBE_MARKER";
const READY_PATTERN = /READY:(\d+)\n/;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_CHARS = 4_096;

export interface ProbeOptions {
	readonly timeoutMs?: number;
	readonly maxBytes?: number;
}

export interface ServerStartOptions {
	readonly command: readonly string[];
	readonly cwd: string;
	readonly host: string;
	/** 0 lets the child choose an ephemeral port; any other value must be the port the child reports. */
	readonly port: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly startupTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly stopGraceMs?: number;
}

export interface RunningServer {
	readonly pid: number;
	readonly port: number;
	readonly baseUrl: string;
	/** Sends SIGTERM, escalates to SIGKILL after the grace period, and resolves once the child has exited. */
	stop(): Promise<void>;
}

export interface ServerIdentity {
	readonly port: number;
	readonly marker: string;
}

export interface BoundedResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

export interface PageInspection {
	readonly status: number;
	/** True when the expected text is in the first HTML response, before any JavaScript runs. */
	readonly serverRendered: boolean;
}

export interface JsonResponse {
	readonly status: number;
	readonly json: unknown;
}

export interface AssetResponse {
	readonly status: number;
	readonly contentType: string | null;
	readonly cacheControl: string | null;
	readonly body: Uint8Array;
}

export interface StreamOptions extends ProbeOptions {
	readonly minimumGapMs?: number;
}

export interface StreamTiming {
	readonly chunks: number;
	readonly firstChunkMs: number;
	readonly endMs: number;
	readonly gapMs: number;
}

/** Starts a child server, verifies its identity, and always stops it when `use` settles. */
export async function withServer<T>(
	options: ServerStartOptions,
	use: (server: RunningServer) => Promise<T>,
): Promise<T> {
	const server = await startServer(options);
	try {
		return await use(server);
	} finally {
		await server.stop();
	}
}

/** Starts a child server and resolves only after the reported port and marker identity check passes. */
export async function startServer(options: ServerStartOptions): Promise<RunningServer> {
	const [program, ...args] = options.command;
	if (program === undefined) throw new Error("server command must not be empty");
	const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
	const marker = randomBytes(16).toString("hex");

	const child = spawn(program, args, {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
			AWS_LAMBDA_HTTP_ENDPOINT: `${options.host}:${options.port}`,
			[MARKER_ENV]: marker,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});

	const stop = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) {
			await exited;
			return;
		}
		child.kill("SIGTERM");
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const forceKill = new Promise<void>((resolve) => {
			escalation = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, stopGraceMs);
		});
		await Promise.race([exited, forceKill]);
		clearTimeout(escalation);
		await exited;
	};

	let stdoutTail = "";
	let stderrTail = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderrTail = tail(stderrTail + chunk.toString("utf8"));
	});

	const ready = new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`server did not report READY within ${startupTimeoutMs}ms; stderr: ${stderrTail}`));
		}, startupTimeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutTail = tail(stdoutTail + chunk.toString("utf8"));
			const match = READY_PATTERN.exec(stdoutTail);
			if (match) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`server exited before READY (code ${code}, signal ${signal}); stderr: ${stderrTail}`));
		});
	});

	try {
		const port = await ready;
		if (options.port !== 0 && port !== options.port) {
			throw new Error(`server reported port ${port} but ${options.port} was requested`);
		}
		const baseUrl = `http://${formatHost(options.host)}:${port}`;
		await verifyIdentity(baseUrl, { port, marker }, { timeoutMs: requestTimeoutMs });
		return { pid: child.pid ?? 0, port, baseUrl, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

/** Confirms that the server at baseUrl is on the expected port and presents the expected marker. */
export async function verifyIdentity(
	baseUrl: string,
	expected: ServerIdentity,
	options: ProbeOptions = {},
): Promise<void> {
	if (new URL(baseUrl).port !== String(expected.port)) {
		throw new Error(`${baseUrl} is not the expected port ${expected.port}`);
	}
	const response = await getBounded(baseUrl, IDENTITY_PATH, options);
	if (response.status !== 200) {
		throw new Error(`${baseUrl}${IDENTITY_PATH} returned ${response.status}, expected 200`);
	}
	const identity = parseJson(decode(response.body), `${baseUrl}${IDENTITY_PATH}`) as Partial<Record<keyof ServerIdentity, unknown>>;
	if (identity.port !== expected.port) {
		throw new Error(`identity reports port ${String(identity.port)}, expected ${expected.port}`);
	}
	if (identity.marker !== expected.marker) {
		throw new Error(`identity marker mismatch at ${baseUrl}; the server on this port is not the started server`);
	}
}

export function getBounded(baseUrl: string, path: string, options: ProbeOptions = {}): Promise<BoundedResponse> {
	return requestBounded(baseUrl, path, { method: "GET" }, options);
}

/** Fetches the first HTML response and checks for text without executing any script. */
export async function inspectPage(
	baseUrl: string,
	path: string,
	expectedText: string,
	options: ProbeOptions = {},
): Promise<PageInspection> {
	const response = await getBounded(baseUrl, path, options);
	return {
		status: response.status,
		serverRendered: decode(response.body).includes(expectedText),
	};
}

export async function assertServerRendered(
	baseUrl: string,
	path: string,
	expectedText: string,
	options: ProbeOptions = {},
): Promise<void> {
	const page = await inspectPage(baseUrl, path, expectedText, options);
	if (page.status !== 200) throw new Error(`${path} returned ${page.status}, expected 200`);
	if (!page.serverRendered) {
		throw new Error(`${path} does not contain "${expectedText}" in the initial HTML response without executing JavaScript`);
	}
}

export async function postJson(
	baseUrl: string,
	path: string,
	value: unknown,
	options: ProbeOptions = {},
): Promise<JsonResponse> {
	const response = await requestBounded(
		baseUrl,
		path,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		},
		options,
	);
	return { status: response.status, json: parseJson(decode(response.body), path) };
}

export async function readAsset(baseUrl: string, path: string, options: ProbeOptions = {}): Promise<AssetResponse> {
	const response = await getBounded(baseUrl, path, options);
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		cacheControl: response.headers.get("cache-control"),
		body: response.body,
	};
}

/**
 * Fails unless the first chunk arrives at least minimumGapMs before the response ends.
 * A response that is buffered and flushed at end-of-stream has a gap near zero.
 */
export async function assertStreamsIncrementally(
	baseUrl: string,
	path: string,
	options: StreamOptions = {},
): Promise<StreamTiming> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const minimumGapMs = options.minimumGapMs ?? 100;
	const url = new URL(path, baseUrl);
	const label = `GET ${url}`;

	const arrivals: number[] = [];
	let started = 0;
	let endedAt = 0;
	let status = 0;
	await withDeadline(label, timeoutMs, async (signal) => {
		const response = await fetch(url, { redirect: "manual", signal });
		status = response.status;
		started = performance.now();
		await readBody(response, maxBytes, label, () => arrivals.push(performance.now()));
		endedAt = performance.now();
	});

	if (status !== 200) throw new Error(`${label} returned ${status}, expected 200`);
	if (arrivals.length === 0) throw new Error(`${label} returned no body`);
	const firstChunkAt = arrivals[0] ?? endedAt;
	const gapMs = endedAt - firstChunkAt;
	if (gapMs < minimumGapMs) {
		throw new Error(
			`${label} is not incremental: first chunk arrived ${gapMs.toFixed(0)}ms before the response ended (minimum ${minimumGapMs}ms)`,
		);
	}
	return {
		chunks: arrivals.length,
		firstChunkMs: firstChunkAt - started,
		endMs: endedAt - started,
		gapMs,
	};
}

async function requestBounded(
	baseUrl: string,
	path: string,
	init: RequestInit,
	options: ProbeOptions,
): Promise<BoundedResponse> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const url = new URL(path, baseUrl);
	const label = `${init.method ?? "GET"} ${url}`;
	return withDeadline(label, timeoutMs, async (signal) => {
		const response = await fetch(url, { ...init, redirect: "manual", signal });
		const body = await readBody(response, maxBytes, label);
		return { status: response.status, headers: response.headers, body };
	});
}

/** Aborts the whole operation, including body reads, after timeoutMs. */
async function withDeadline<T>(label: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await run(controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function readBody(
	response: Response,
	maxBytes: number,
	label: string,
	onChunk?: () => void,
): Promise<Uint8Array> {
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`${label} body exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
		onChunk?.();
	}
	return Buffer.concat(chunks);
}

function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} did not return JSON`);
	}
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function tail(text: string): string {
	return text.length > LOG_TAIL_CHARS ? text.slice(-LOG_TAIL_CHARS) : text;
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
