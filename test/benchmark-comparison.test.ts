import { expect, test } from "bun:test";
import { summarizeCells, verifiedColdTrials, parseClassicInit } from "../examples/benchmark/comparison";

test("repeated cells use total successful requests divided by total measured time", () => {
	const cells = [
		{ server: "hono", scenario: "ping", concurrency: 1, totalRequests: 10, errorCount: 2, durationMs: 1000, rps: 8, p50Ms: 1, p95Ms: 2, p99Ms: 3, uniqueSandboxes: 1 },
		{ server: "hono", scenario: "ping", concurrency: 1, totalRequests: 20, errorCount: 0, durationMs: 2000, rps: 10, p50Ms: 3, p95Ms: 4, p99Ms: 5, uniqueSandboxes: 2 },
	];
	const result = summarizeCells(cells)[0]!;
	expect(result.rps).toBeCloseTo(28 / 3, 5);
	expect(result.errorCount).toBe(2);
	expect(result.p50Ms).toBe(2);
	expect(result.repeats).toBe(2);
	expect(result.sandboxCounts).toEqual([1, 2]);
});

test("classic Lambda REPORT init and memory fields are parsed without fabricating CPU", () => {
	expect(parseClassicInit("REPORT RequestId: test\tDuration: 8.80 ms\tBilled Duration: 103 ms\tMemory Size: 2048 MB\tMax Memory Used: 37 MB\tInit Duration: 93.71 ms\t")).toEqual({ totalDurationMs: 93.71, maxMemoryUsageMb: 37 });
});

test("cold timings from a previous AWS revision are not treated as new-revision cold starts", () => {
	const valid = { revisionId: "rev-new", elapsedMs: 400, headers: { "lambda-web-logstream": "fn[rev-new]instance" } };
	const stale = { revisionId: "rev-new", elapsedMs: 40, headers: { "lambda-web-logstream": "fn[rev-old]instance" } };
	expect(verifiedColdTrials([valid, stale])).toEqual([valid]);
});
