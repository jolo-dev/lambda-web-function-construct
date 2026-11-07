import { expect, test } from "bun:test";
import { buildOhaArgs, parseOhaResult, summarizeOhaCells, parseAwsCliOutput, stableJson } from "../examples/benchmark/oha";

test("unreserved Lambda concurrency may have empty CLI stdout, other empty responses are rejected", () => {
	expect(parseAwsCliOutput("", true)).toEqual({});
	expect(() => parseAwsCliOutput("")).toThrow();
});

test("configuration read-back ignores JSON object key ordering", () => {
	expect(stableJson({ scaling: {}, config: { timeout: 30, concurrency: 64 } })).toBe(stableJson({ config: { concurrency: 64, timeout: 30 }, scaling: {} }));
	expect(stableJson({ max: 8 })).not.toBe(stableJson({ max: 16 }));
});

const fixture = {
	summary: { total: 2, requestsPerSec: 4, successRate: 1 },
	statusCodeDistribution: { "200": 4, "429": 4 },
	errorDistribution: {},
	latencyPercentilesSuccessful: { p50: 0.04, p95: 0.08, p99: 0.1 },
};

test("oha successRate=1 does not make HTTP 429 a successful API response", () => {
	const result = parseOhaResult(fixture);
	expect(result.successfulRequests).toBe(4);
	expect(result.httpFailures).toBe(4);
	expect(result.successfulRps).toBe(2);
	expect(result.failureRate).toBe(0.5);
	expect(result.p50Ms).toBe(40);
});

test("transport errors remain failures and all-error runs have no success latency", () => {
	const result = parseOhaResult({ ...fixture, statusCodeDistribution: { "503": 2 }, errorDistribution: { timeout: 3 } });
	expect(result.totalAttempts).toBe(5);
	expect(result.transportErrors).toBe(3);
	expect(result.httpFailures).toBe(2);
	expect(result.successfulRps).toBe(0);
	expect(result.p50Ms).toBeNull();
});

test("missing successful-response percentiles are rejected, never replaced by fast error latency", () => {
	expect(() => parseOhaResult({ ...fixture, latencyPercentilesSuccessful: undefined })).toThrow();
	expect(() => parseOhaResult({ ...fixture, summary: { total: 0 } })).toThrow();
});

test("repeat summaries weight throughput by actual duration and label run-level percentiles", () => {
	const first = { server: "hono", concurrency: 64, ...parseOhaResult(fixture) };
	const second = { server: "hono", concurrency: 64, ...parseOhaResult({ ...fixture, summary: { total: 8 }, statusCodeDistribution: { "200": 16 }, latencyPercentilesSuccessful: { p50: 0.08, p95: 0.1, p99: 0.2 } }) };
	const [result] = summarizeOhaCells([first, second]);
	expect(result.successfulRps).toBe(2);
	expect(result.totalAttempts).toBe(24);
	expect(result.failureRate).toBeCloseTo(4 / 24);
	expect(result.p50Ms).toBe(60);
});

test("installed oha JSON is parsed correctly against real mixed HTTP responses", async () => {
	let count = 0;
	const server = Bun.serve({ port: 0, fetch() { return new Response("ok", { status: count++ % 2 ? 429 : 200 }); } });
	try {
		// A non-resolvable hostname exercises the same explicit-IP path used on macOS.
		const target = `http://oha-benchmark.invalid:${server.port}`;
		const built = buildOhaArgs(target, 1, 1, ["127.0.0.1"]);
		const index = built.indexOf("--connect-to");
		const child = Bun.spawn(["oha", "-n", "20", "-c", "1", "--no-tui", "--stats-success-breakdown", "--output-format", "json", ...built.slice(index,index+2), target], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exit, stderr).toBe(0);
		const result = parseOhaResult(JSON.parse(stdout));
		expect(result.successfulRequests).toBe(10);
		expect(result.httpFailures).toBe(10);
		expect(result.failureRate).toBe(0.5);
	} finally { server.stop(true); }
}, { skip: !Bun.which("oha"), timeout: 10000 });

test("oha uses HTTP/1.1, bounded timeouts, status breakdowns and drains ongoing requests", () => {
	const args = buildOhaArgs("https://example.com/io?delayMs=30", 64, 30);
	expect(args).toContain("--stats-success-breakdown");
	expect(args).toContain("--wait-ongoing-requests-after-deadline");
	expect(args).toContain("1.1");
	expect(args).toContain("30s");
	expect(args).toContain("64");
	expect(() => buildOhaArgs("https://example.com", 0, 30)).toThrow();
	const mapped = buildOhaArgs("https://example.com/io", 64, 30, ["192.0.2.1", "192.0.2.2"]);
	expect(mapped).toContain("example.com:443:192.0.2.1:443");
	expect(mapped).toContain("example.com:443:192.0.2.2:443");
	expect(mapped.at(-1)).toBe("https://example.com/io");
	expect(mapped).not.toContain("--insecure");
});
