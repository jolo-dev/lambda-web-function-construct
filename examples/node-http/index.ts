import http from "node:http";
import {
	clampInt,
	delay,
	parseListenEndpoint,
	processJsonPayload,
	recordRequestSample,
	runComputeIterations,
	takeTelemetrySnapshot,
} from "../shared/workload";

const SERVER_NAME = "node-http";
const { host, port } = parseListenEndpoint();

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
	const payload = JSON.stringify(data);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
	const pathname = url.pathname;
	const method = req.method ?? "GET";

	if ((method === "GET" || method === "HEAD") && pathname === "/ping") {
		recordRequestSample();
		sendJson(res, 200, { ok: true, server: SERVER_NAME });
		return;
	}

	if (method === "GET" && pathname === "/headers") {
		recordRequestSample();
		sendJson(res, 200, {
			server: SERVER_NAME,
			method,
			url: req.url,
			headers: req.headers,
			endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
		});
		return;
	}

	if (method === "POST" && pathname.startsWith("/json/")) {
		const id = decodeURIComponent(pathname.slice("/json/".length));
		const mode = url.searchParams.get("mode") ?? "default";
		const raw = await readBody(req);
		const parsed = raw.length > 0 ? JSON.parse(raw) : {};
		sendJson(res, 200, processJsonPayload(SERVER_NAME, id, mode, parsed));
		return;
	}

	if (method === "GET" && pathname === "/io") {
		recordRequestSample();
		const delayMs = clampInt(url.searchParams.get("delayMs"), 50, 1, 2000);
		await delay(delayMs);
		sendJson(res, 200, { ok: true, server: SERVER_NAME, delayMs });
		return;
	}

	if (method === "GET" && pathname === "/stream") {
		recordRequestSample();
		const chunks = clampInt(url.searchParams.get("chunks"), 10, 1, 100);
		const intervalMs = clampInt(url.searchParams.get("intervalMs"), 10, 0, 500);
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			"x-accel-buffering": "no",
		});
		res.flushHeaders();
		for (let i = 0; i < chunks; i++) {
			if (i > 0 && intervalMs > 0) {
				await delay(intervalMs);
			}
			res.write(`data: ${JSON.stringify({ chunk: i, server: SERVER_NAME, ts: Date.now() })}\n\n`);
		}
		res.end();
		return;
	}

	if (method === "POST" && pathname === "/compute") {
		const iterations = clampInt(url.searchParams.get("iterations"), 2000, 1, 50000);
		const raw = await readBody(req);
		sendJson(res, 200, runComputeIterations(SERVER_NAME, iterations, raw || undefined));
		return;
	}

	if (method === "GET" && pathname === "/__telemetry") {
		const reset = url.searchParams.get("reset") === "1";
		sendJson(res, 200, takeTelemetrySnapshot(SERVER_NAME, reset));
		return;
	}

	sendJson(res, 404, { error: "Not Found", path: pathname, server: SERVER_NAME });
});

server.listen(port, host);
process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
});
