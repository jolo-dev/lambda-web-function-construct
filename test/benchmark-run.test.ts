import { afterEach, expect, test } from "bun:test";
import { runScenarioCell, pingPath, validateWorkloadResponse, BARE_TRACK_SERVERS, SERVERS } from "../examples/benchmark/run";
import { BARE_PROCESS_SERVERS } from "../examples/benchmark/bare-process";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

test("standalone bare-process benchmark selects five local servers and excludes API Gateway", () => {
	expect(BARE_PROCESS_SERVERS).toEqual(["node-http", "express", "hono", "h3", "bun-http"]);
	expect(BARE_PROCESS_SERVERS).not.toContain("lambda-apigw");
});

function start(status = 200, logstream?: string) {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/__telemetry") {
				return Response.json({ cpuUserUs: 0, cpuSystemUs: 0, peakRssMb: 10, peakHeapUsedMb: 5 });
			}
			return new Response("ok", {
				status,
				headers: logstream ? { "lambda-web-logstream": logstream } : {},
			});
		},
	});
	return `http://127.0.0.1:${server.port}`;
}
const scenario = { id: "ping", path: "/ping", method: "GET" as const, durationMs: 30 };

test("AWS API Gateway uses a non-reserved health path", () => {
	expect(pingPath("lambda-apigw")).toBe("/healthz");
	expect(pingPath("hono")).toBe("/ping");
});
test("a gateway service-health response is rejected instead of benchmarked as Lambda", () => {
	expect(() => validateWorkloadResponse("lambda-apigw", "ping", "Healthy Connection")).toThrow();
	expect(() => validateWorkloadResponse("lambda-apigw", "ping", JSON.stringify({ ok: true, server: "lambda-apigw" }))).not.toThrow();
	expect(() => validateWorkloadResponse("lambda-apigw", "ping", JSON.stringify({ ok: true, server: "other" }))).toThrow();
});

test("AWS event function sandbox count is unknown without an instance identifier", async () => {
	const result = await runScenarioCell("aws-lambda", "lambda-apigw", start(), scenario, 1);
	expect(result.uniqueSandboxes).toBeNull();
	expect(result.totalRequests).toBeGreaterThan(0);
});

test("AWS Web Function sandbox count uses observed logstream headers", async () => {
	const result = await runScenarioCell("aws-lambda", "hono", start(200, "sandbox-a"), scenario, 2);
	expect(result.uniqueSandboxes).toBe(1);
});

test("load results retain HTTP failure counts rather than hiding them in RPS", async () => {
	const result = await runScenarioCell("aws-lambda", "hono", start(429), scenario, 1);
	expect(result.errorCount).toBe(result.totalRequests);
	expect(result.statusCounts["429"]).toBe(result.totalRequests);
	expect(result.rps).toBe(0);
});

test("bench:run bare-process track excludes API Gateway while LocalStack keeps all six servers", () => {
	expect(BARE_TRACK_SERVERS).toEqual(["node-http", "express", "hono", "h3", "bun-http"]);
	expect(BARE_TRACK_SERVERS).not.toContain("lambda-apigw");
	expect(SERVERS).toContain("lambda-apigw");
});
