import express from "express";
import {
	clampInt,
	delay,
	parseListenEndpoint,
	processJsonPayload,
	recordRequestSample,
	runComputeIterations,
	takeTelemetrySnapshot,
} from "../shared/workload";

const SERVER_NAME = "express";
const { host, port } = parseListenEndpoint();

const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/*", limit: "2mb" }));

app.get("/ping", (_req, res) => {
	recordRequestSample();
	res.status(200).json({ ok: true, server: SERVER_NAME });
});

app.get("/headers", (req, res) => {
	recordRequestSample();
	res.status(200).json({
		server: SERVER_NAME,
		method: req.method,
		url: req.originalUrl,
		headers: req.headers,
		endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
	});
});

app.post("/json/:id", (req, res) => {
	const id = String(req.params.id ?? "");
	const mode = typeof req.query.mode === "string" ? req.query.mode : "default";
	res.status(200).json(processJsonPayload(SERVER_NAME, id, mode, req.body));
});

app.get("/io", async (req, res) => {
	recordRequestSample();
	const delayMs = clampInt(
		typeof req.query.delayMs === "string" ? req.query.delayMs : undefined,
		50,
		1,
		2000,
	);
	await delay(delayMs);
	res.status(200).json({ ok: true, server: SERVER_NAME, delayMs });
});

app.get("/stream", async (req, res) => {
	recordRequestSample();
	const chunks = clampInt(
		typeof req.query.chunks === "string" ? req.query.chunks : undefined,
		10,
		1,
		100,
	);
	const intervalMs = clampInt(
		typeof req.query.intervalMs === "string" ? req.query.intervalMs : undefined,
		10,
		0,
		500,
	);
	res.status(200);
	res.setHeader("content-type", "text/event-stream; charset=utf-8");
	res.setHeader("cache-control", "no-cache");
	res.setHeader("x-accel-buffering", "no");
	res.flushHeaders();
	for (let i = 0; i < chunks; i++) {
		if (i > 0 && intervalMs > 0) {
			await delay(intervalMs);
		}
		res.write(`data: ${JSON.stringify({ chunk: i, server: SERVER_NAME, ts: Date.now() })}\n\n`);
	}
	res.end();
});

app.post("/compute", (req, res) => {
	const iterations = clampInt(
		typeof req.query.iterations === "string" ? req.query.iterations : undefined,
		2000,
		1,
		50000,
	);
	const seed =
		typeof req.body === "string" && req.body.length > 0
			? req.body
			: undefined;
	res.status(200).json(runComputeIterations(SERVER_NAME, iterations, seed));
});

app.get("/__telemetry", (req, res) => {
	const reset = req.query.reset === "1";
	res.status(200).json(takeTelemetrySnapshot(SERVER_NAME, reset));
});

const server = app.listen(port, host);
process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
});
