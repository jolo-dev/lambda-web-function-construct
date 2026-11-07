import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	clampInt,
	delay,
	parseListenEndpoint,
	processJsonPayload,
	recordRequestSample,
	runComputeIterations,
	takeTelemetrySnapshot,
} from "../shared/workload";

const SERVER_NAME = "hono";
const { host, port } = parseListenEndpoint();

const app = new Hono();

app.get("/ping", (c) => {
	recordRequestSample();
	return c.json({ ok: true, server: SERVER_NAME });
});

app.get("/headers", (c) => {
	recordRequestSample();
	const headers: Record<string, string> = {};
	c.req.raw.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return c.json({
		server: SERVER_NAME,
		method: c.req.method,
		url: c.req.path,
		headers,
		endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
	});
});

app.post("/json/:id", async (c) => {
	const id = c.req.param("id");
	const mode = c.req.query("mode") ?? "default";
	const body = await c.req.json().catch(() => ({}));
	return c.json(processJsonPayload(SERVER_NAME, id, mode, body));
});

app.get("/io", async (c) => {
	recordRequestSample();
	const delayMs = clampInt(c.req.query("delayMs"), 50, 1, 2000);
	await delay(delayMs);
	return c.json({ ok: true, server: SERVER_NAME, delayMs });
});

app.get("/stream", (c) => {
	recordRequestSample();
	const chunks = clampInt(c.req.query("chunks"), 10, 1, 100);
	const intervalMs = clampInt(c.req.query("intervalMs"), 10, 0, 500);
	return streamSSE(c, async (stream) => {
		for (let i = 0; i < chunks; i++) {
			if (i > 0 && intervalMs > 0) {
				await stream.sleep(intervalMs);
			}
			await stream.writeSSE({
				data: JSON.stringify({ chunk: i, server: SERVER_NAME, ts: Date.now() }),
			});
		}
	});
});

app.post("/compute", async (c) => {
	const iterations = clampInt(c.req.query("iterations"), 2000, 1, 50000);
	const seed = await c.req.text();
	return c.json(runComputeIterations(SERVER_NAME, iterations, seed || undefined));
});

app.get("/__telemetry", (c) => {
	const reset = c.req.query("reset") === "1";
	return c.json(takeTelemetrySnapshot(SERVER_NAME, reset));
});

const server = serve({
	fetch: app.fetch,
	hostname: host,
	port,
});

process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
});
