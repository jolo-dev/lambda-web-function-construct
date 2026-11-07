import http from "node:http";
import { H3, toNodeHandler } from "h3/node";
import {
	clampInt,
	delay,
	parseListenEndpoint,
	processJsonPayload,
	recordRequestSample,
	runComputeIterations,
	takeTelemetrySnapshot,
} from "../shared/workload";

const SERVER_NAME = "h3";
const { host, port } = parseListenEndpoint();

const app = new H3();

app.get("/ping", () => {
	recordRequestSample();
	return { ok: true, server: SERVER_NAME };
});

app.get("/headers", (event) => {
	recordRequestSample();
	const headers: Record<string, string> = {};
	event.req.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return {
		server: SERVER_NAME,
		method: event.req.method,
		url: event.url.pathname + event.url.search,
		headers,
		endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
	};
});

app.post("/json/:id", async (event) => {
	const id = event.context.params?.id ?? "";
	const mode = event.url.searchParams.get("mode") ?? "default";
	const body = await event.req.json().catch(() => ({}));
	return processJsonPayload(SERVER_NAME, id, mode, body);
});

app.get("/io", async (event) => {
	recordRequestSample();
	const delayMs = clampInt(event.url.searchParams.get("delayMs"), 50, 1, 2000);
	await delay(delayMs);
	return { ok: true, server: SERVER_NAME, delayMs };
});

app.get("/stream", (event) => {
	recordRequestSample();
	const chunks = clampInt(event.url.searchParams.get("chunks"), 10, 1, 100);
	const intervalMs = clampInt(event.url.searchParams.get("intervalMs"), 10, 0, 500);
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			for (let i = 0; i < chunks; i++) {
				if (i > 0 && intervalMs > 0) {
					await delay(intervalMs);
				}
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ chunk: i, server: SERVER_NAME, ts: Date.now() })}\n\n`,
					),
				);
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			"x-accel-buffering": "no",
		},
	});
});

app.post("/compute", async (event) => {
	const iterations = clampInt(event.url.searchParams.get("iterations"), 2000, 1, 50000);
	const seed = await event.req.text();
	return runComputeIterations(SERVER_NAME, iterations, seed || undefined);
});

app.get("/__telemetry", (event) => {
	const reset = event.url.searchParams.get("reset") === "1";
	return takeTelemetrySnapshot(SERVER_NAME, reset);
});

const server = http.createServer(toNodeHandler(app));
server.listen(port, host);
process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
});
