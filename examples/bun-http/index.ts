import {
	clampInt,
	delay,
	parseListenEndpoint,
	processJsonPayload,
	recordRequestSample,
	runComputeIterations,
	takeTelemetrySnapshot,
} from "../shared/workload";

const SERVER_NAME = "bun-http";
const { host, port } = parseListenEndpoint();

export function startBunServer(listenHost = host, listenPort = port) {
	return Bun.serve({
		hostname: listenHost,
		port: listenPort,
		async fetch(req) {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const method = req.method;

			if ((method === "GET" || method === "HEAD") && pathname === "/ping") {
				recordRequestSample();
				return Response.json({ ok: true, server: SERVER_NAME });
			}

			if (method === "GET" && pathname === "/headers") {
				recordRequestSample();
				const headers: Record<string, string> = {};
				req.headers.forEach((value, key) => {
					headers[key] = value;
				});
				return Response.json({
					server: SERVER_NAME,
					method,
					url: pathname + url.search,
					headers,
					endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
				});
			}

			if (method === "POST" && pathname.startsWith("/json/")) {
				const id = decodeURIComponent(pathname.slice("/json/".length));
				const mode = url.searchParams.get("mode") ?? "default";
				const body = await req.json().catch(() => ({}));
				return Response.json(processJsonPayload(SERVER_NAME, id, mode, body));
			}

			if (method === "GET" && pathname === "/io") {
				recordRequestSample();
				const delayMs = clampInt(url.searchParams.get("delayMs"), 50, 1, 2000);
				await delay(delayMs);
				return Response.json({ ok: true, server: SERVER_NAME, delayMs });
			}

			if (method === "GET" && pathname === "/stream") {
				recordRequestSample();
				const chunks = clampInt(url.searchParams.get("chunks"), 10, 1, 100);
				const intervalMs = clampInt(url.searchParams.get("intervalMs"), 10, 0, 500);
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
			}

			if (method === "POST" && pathname === "/compute") {
				const iterations = clampInt(url.searchParams.get("iterations"), 2000, 1, 50000);
				const seed = await req.text();
				return Response.json(runComputeIterations(SERVER_NAME, iterations, seed || undefined));
			}

			if (method === "GET" && pathname === "/__telemetry") {
				const reset = url.searchParams.get("reset") === "1";
				return Response.json(takeTelemetrySnapshot(SERVER_NAME, reset));
			}

			return Response.json(
				{ error: "Not Found", path: pathname, server: SERVER_NAME },
				{ status: 404 },
			);
		},
	});
}

if (import.meta.main) {
	const srv = startBunServer(host, port);
	process.on("SIGTERM", () => {
		srv.stop(true);
		process.exit(0);
	});
}
