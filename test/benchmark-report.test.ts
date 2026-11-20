import { expect, test } from "bun:test";
import { generateMarkdown, generateHtml } from "../examples/benchmark/report";
import type { BenchmarkReportData } from "../examples/benchmark/run";

const data: BenchmarkReportData = {
	generatedAt: "2026-01-01T00:00:00.000Z",
	environment: { hostArch: "x64", nodeVersion: "24.0.0", bunVersion: "1.4.4", localstackVersion: "test" },
	endpoints: {},
	artifacts: [],
	coldStarts: [{
		server: "hono",
		deploymentModel: "Lambda Web Function (nodejs24.x ZIP)",
		trialsMs: [300, 325, 350],
		medianColdStartMs: 325,
		meanColdStartMs: 325,
		warmP50Ms: 10,
		initReportDurationMs: 100,
	}],
	results: [{
		track: "localstack-lambda",
		server: "hono",
		scenario: "async-io-30ms",
		concurrency: 64,
		totalRequests: 200,
		errorCount: 0,
		durationMs: 1000,
		rps: 200,
		p50Ms: 30,
		p90Ms: 31,
		p95Ms: 32,
		p99Ms: 33,
		maxMs: 34,
		cpuUserMs: 20,
		cpuSystemMs: 10,
		cpuTotalMs: 30,
		activeCpuMsPer1kReq: 150,
		peakRssMb: 40,
		peakHeapUsedMb: 12,
		uniqueSandboxes: 1,
		statusCounts: { "200": 200 },
	}],
	contractProbes: [],
	cloudWatch: [],
};

test("historical report does not extrapolate emulator timings into an AWS winner or bill", () => {
	const markdown = generateMarkdown(data);
	expect(markdown).toContain("LocalStack-only");
	expect(markdown).toContain("different concurrency");
	expect(markdown).toContain("AWS_RESULTS.md");
	expect(markdown).not.toContain("MOST EXPENSIVE");
	expect(markdown).not.toContain("$2.06");
});
test("dashboard keeps explicit metric directions, actual cold timings and an explorer", () => {
	const html = generateHtml(data);
	expect(html).toContain("Higher is better");
	expect(html).toContain("Lower is better");
	expect(html).toContain("Scenario explorer");
	expect(html).toContain("aws-report.html");
	expect(html).toContain("300.00, 325.00, 350.00");
	expect(html).toContain("hono c=64");
	expect(html).not.toContain("64 Separate Cold Starts");
});
