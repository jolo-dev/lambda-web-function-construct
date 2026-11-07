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

const SERVER_NAME = "lambda-apigw";

export interface ApiGatewayV2Event {
	version?: string;
	rawPath?: string;
	rawQueryString?: string;
	headers?: Record<string, string | undefined>;
	queryStringParameters?: Record<string, string | undefined>;
	requestContext?: {
		requestId?: string;
		http?: {
			method?: string;
			path?: string;
		};
	};
	body?: string | null;
	isBase64Encoded?: boolean;
	httpMethod?: string;
	path?: string;
}

export interface ApiGatewayV2Result {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	isBase64Encoded?: boolean;
}

export async function handler(
	event: ApiGatewayV2Event,
	context?: { awsRequestId?: string },
): Promise<ApiGatewayV2Result> {
	const method =
		event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
	const rawPath =
		event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
	const rawQuery = event.rawQueryString ?? "";
	const searchParams = new URLSearchParams(rawQuery);
	const requestId =
		context?.awsRequestId ?? event.requestContext?.requestId ?? "local";

	const baseHeaders: Record<string, string> = {
		"content-type": "application/json; charset=utf-8",
		"x-lambda-request-id": requestId,
	};

	// Strip optional stage prefix if present (e.g. /$default/ping -> /ping)
	const pathname = rawPath.replace(/^\/\$default(?=\/|$)/, "") || "/";

	// API Gateway reserves root /ping for its own service health response on AWS.
	if ((method === "GET" || method === "HEAD") && (pathname === "/ping" || pathname === "/healthz")) {
		recordRequestSample();
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify({ ok: true, server: SERVER_NAME }),
		};
	}

	if (method === "GET" && pathname === "/headers") {
		recordRequestSample();
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify({
				server: SERVER_NAME,
				method,
				url: rawQuery ? `${pathname}?${rawQuery}` : pathname,
				headers: event.headers ?? {},
				endpointEnv: process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? null,
			}),
		};
	}

	if (method === "POST" && pathname.startsWith("/json/")) {
		const id = decodeURIComponent(pathname.slice("/json/".length));
		const mode =
			searchParams.get("mode") ??
			event.queryStringParameters?.mode ??
			"default";
		let rawBody = event.body ?? "";
		if (event.isBase64Encoded && rawBody) {
			rawBody = Buffer.from(rawBody, "base64").toString("utf8");
		}
		const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify(processJsonPayload(SERVER_NAME, id, mode, parsed)),
		};
	}

	if (method === "GET" && pathname === "/io") {
		recordRequestSample();
		const delayMs = clampInt(
			searchParams.get("delayMs") ?? event.queryStringParameters?.delayMs,
			50,
			1,
			2000,
		);
		await delay(delayMs);
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify({ ok: true, server: SERVER_NAME, delayMs }),
		};
	}

	if (method === "GET" && pathname === "/stream") {
		recordRequestSample();
		const chunks = clampInt(
			searchParams.get("chunks") ?? event.queryStringParameters?.chunks,
			10,
			1,
			100,
		);
		const intervalMs = clampInt(
			searchParams.get("intervalMs") ?? event.queryStringParameters?.intervalMs,
			10,
			0,
			500,
		);
		const frames: string[] = [];
		for (let i = 0; i < chunks; i++) {
			if (i > 0 && intervalMs > 0) {
				await delay(intervalMs);
			}
			frames.push(
				`data: ${JSON.stringify({ chunk: i, server: SERVER_NAME, ts: Date.now() })}\n\n`,
			);
		}
		return {
			statusCode: 200,
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				"x-accel-buffering": "no",
				"x-lambda-request-id": requestId,
			},
			body: frames.join(""),
		};
	}

	if (method === "POST" && pathname === "/compute") {
		const iterations = clampInt(
			searchParams.get("iterations") ?? event.queryStringParameters?.iterations,
			2000,
			1,
			50000,
		);
		let rawBody = event.body ?? "";
		if (event.isBase64Encoded && rawBody) {
			rawBody = Buffer.from(rawBody, "base64").toString("utf8");
		}
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify(
				runComputeIterations(SERVER_NAME, iterations, rawBody || undefined),
			),
		};
	}

	if (method === "GET" && pathname === "/__telemetry") {
		const reset =
			(searchParams.get("reset") ?? event.queryStringParameters?.reset) === "1";
		return {
			statusCode: 200,
			headers: baseHeaders,
			body: JSON.stringify(takeTelemetrySnapshot(SERVER_NAME, reset)),
		};
	}

	return {
		statusCode: 404,
		headers: baseHeaders,
		body: JSON.stringify({
			error: "Not Found",
			path: pathname,
			server: SERVER_NAME,
		}),
	};
}

// Allow running in Track 1 (bare-process baseline) when AWS_LAMBDA_HTTP_ENDPOINT is set
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
	const { host, port } = parseListenEndpoint();
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", async () => {
			const url = new URL(
				req.url ?? "/",
				`http://${req.headers.host || "localhost"}`,
			);
			const headers: Record<string, string | undefined> = {};
			for (const [k, v] of Object.entries(req.headers)) {
				headers[k] = Array.isArray(v) ? v.join(", ") : v;
			}
			const result = await handler({
				version: "2.0",
				rawPath: url.pathname,
				rawQueryString: url.search.slice(1),
				headers,
				requestContext: {
					requestId: "bare-local",
					http: { method: req.method ?? "GET", path: url.pathname },
				},
				body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null,
			});
			res.writeHead(result.statusCode, result.headers);
			res.end(result.body);
		});
	});
	server.listen(port, host);
	process.on("SIGTERM", () => {
		server.close(() => process.exit(0));
	});
}
