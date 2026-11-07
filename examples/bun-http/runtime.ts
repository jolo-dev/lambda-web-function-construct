import { startBunServer } from "./index";

// Start Bun's native HTTP server inside the Lambda container
const server = startBunServer("127.0.0.1", 3000);
const baseUrl = `http://127.0.0.1:${server.port}`;

interface LambdaFunctionUrlEvent {
	version?: string;
	rawPath?: string;
	rawQueryString?: string;
	headers?: Record<string, string>;
	requestContext?: {
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

async function runLambdaRuntimeLoop(runtimeApi: string): Promise<void> {
	const runtimeBase = `http://${runtimeApi}/2018-06-01/runtime`;
	while (true) {
		const nextRes = await fetch(`${runtimeBase}/invocation/next`);
		const requestId = nextRes.headers.get("lambda-runtime-aws-request-id") ?? "unknown";
		try {
			const event = (await nextRes.json()) as LambdaFunctionUrlEvent;
			const method =
				event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
			const rawPath =
				event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
			const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
			const targetUrl = `${baseUrl}${rawPath}${qs}`;

			let bodyInit: BodyInit | undefined;
			if (event.body && method !== "GET" && method !== "HEAD") {
				bodyInit = event.isBase64Encoded
					? Buffer.from(event.body, "base64")
					: event.body;
			}

			const upstreamRes = await fetch(targetUrl, {
				method,
				headers: event.headers ?? {},
				body: bodyInit,
			});

			const responseBody = await upstreamRes.text();
			const responseHeaders: Record<string, string> = {};
			const hopByHop = new Set([
				"transfer-encoding",
				"connection",
				"keep-alive",
				"content-length",
			]);
			upstreamRes.headers.forEach((v, k) => {
				if (!hopByHop.has(k.toLowerCase())) {
					responseHeaders[k] = v;
				}
			});
			responseHeaders["x-lambda-request-id"] = requestId;

			await fetch(`${runtimeBase}/invocation/${requestId}/response`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					statusCode: upstreamRes.status,
					headers: responseHeaders,
					body: responseBody,
					isBase64Encoded: false,
				}),
			});
		} catch (err) {
			await fetch(`${runtimeBase}/invocation/${requestId}/error`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					errorMessage: err instanceof Error ? err.message : String(err),
					errorType: "RuntimeError",
				}),
			});
		}
	}
}

const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API;
if (runtimeApi) {
	runLambdaRuntimeLoop(runtimeApi);
}
