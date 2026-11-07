import { expect, test } from "bun:test";
import { bareOhaArgs, bareOhaCells } from "../examples/benchmark/bare-process-oha";
import { SCENARIOS } from "../examples/benchmark/run";

test("oha bare-process matrix matches the local runner: five servers, same workloads and concurrencies", () => {
	const cells = bareOhaCells();
	expect(cells).toHaveLength(75);
	expect(new Set(cells.map((c) => c.server))).toEqual(new Set(["node-http", "express", "hono", "h3", "bun-http"]));
	expect(cells.some((c) => c.server === "lambda-apigw")).toBe(false);
	const json64 = cells.filter((c) => c.scenario === "json-64kb");
	expect(json64).toHaveLength(10);
	expect(new Set(json64.map((c) => c.concurrency))).toEqual(new Set([1, 16]));
	expect(cells.some((c) => c.scenario === "stream-sse" && c.concurrency === 64)).toBe(false);
	expect(cells.some((c) => c.scenario === "ping" && c.concurrency === 64)).toBe(true);
	expect(new Set(SCENARIOS.map((s) => s.id))).toEqual(new Set(cells.map((c) => c.scenario)));
});

test("GET scenarios add no method, body or content-type flags and keep the URL last", () => {
	const args = bareOhaArgs(
		{ id: "ping", path: "/ping", method: "GET", durationMs: 1200 },
		"http://127.0.0.1:4310/ping",
		16,
		5,
	);
	expect(args).not.toContain("-m");
	expect(args).not.toContain("-d");
	expect(args).not.toContain("-T");
	expect(args.at(-1)).toBe("http://127.0.0.1:4310/ping");
	expect(args).toContain("-z");
	expect(args[args.indexOf("-z") + 1]).toBe("5s");
});

test("POST scenarios send their body and content type before the URL", () => {
	const args = bareOhaArgs(
		{ id: "json-1kb", path: "/json/item-1", method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" }, durationMs: 1200 },
		"http://127.0.0.1:4310/json/item-1",
		1,
		5,
	);
	expect(args[args.indexOf("-m") + 1]).toBe("POST");
	expect(args[args.indexOf("-d") + 1]).toBe('{"a":1}');
	expect(args[args.indexOf("-T") + 1]).toBe("application/json");
	expect(args.indexOf("-m")).toBeLessThan(args.length - 1);
	expect(args.at(-1)).toBe("http://127.0.0.1:4310/json/item-1");
});
