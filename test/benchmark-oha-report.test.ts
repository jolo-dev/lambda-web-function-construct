import { expect, test } from "bun:test";
import { barChartSvg, coldStartRows, enhanceOhaMarkdown } from "../examples/benchmark/oha-report";

const coldSource = {
	profile: "jolo", region: "eu-central-1", startedAt: "2026-11-01T14:00:00Z",
	coldStarts: [{ server: "hono", trials: [
		{ revisionId: "rev-new", status: 200, elapsedMs: 400, headers: { "lambda-web-logstream": "fn[rev-new]one" }, body: '{"ok":true,"server":"hono"}' },
		{ revisionId: "rev-new", status: 200, elapsedMs: 100, headers: { "lambda-web-logstream": "fn[rev-old]two" }, body: '{"ok":true,"server":"hono"}' },
		{ revisionId: "rev-next", status: 200, elapsedMs: 600, headers: { "lambda-web-logstream": "fn[rev-next]three" }, body: '{"ok":true,"server":"hono"}' },
	] }, { server: "lambda-apigw", trials: [
		{ status: 200, elapsedMs: 20, headers: {}, body: "Healthy Connection" },
		{ status: 200, elapsedMs: 300, configurationNonce: "new", headers: { "x-lambda-request-id": "real-id" }, body: '{"ok":true,"server":"lambda-apigw"}' },
	] }],
};
const report = { profile: "jolo", region: "eu-central-1", directory: "results/oha-test", before: { endpoints: { hono: "https://example.com", "lambda-apigw": "https://api.example.com" } }, cells: [
	{ server: "hono", concurrency: 64, totalSeconds: 2, successfulRequests: 200, httpFailures: 0, transportErrors: 0, totalAttempts: 200, successfulRps: 100, p50Ms: 20, p95Ms: 30, p99Ms: 40, statusCounts: { "200": 200 } },
] };
const markdown = "# oha results\n\n## Results\n\n| Server | RPS |\n| --- | --- |\n| hono | 100 |\n\n## CloudWatch diagnostic evidence\n\nExisting diagnostics.\n";

test("cold-start times exclude stale revisions and API Gateway service health responses", () => {
	const rows = coldStartRows(coldSource);
	expect(rows.find(r=>r.server === "hono")?.trialsMs).toEqual([400,600]);
	expect(rows.find(r=>r.server === "hono")?.medianMs).toBe(500);
	expect(rows.find(r=>r.server === "lambda-apigw")?.medianMs).toBe(300);
});

test("graph follows the results table and historical cold-start samples are explicitly separate", () => {
	const output = enhanceOhaMarkdown(markdown, report, coldSource);
	expect(output.markdown.indexOf("io-throughput-c64.svg")).toBeGreaterThan(output.markdown.indexOf("| hono | 100 |"));
	expect(output.markdown.indexOf("io-throughput-c64.svg")).toBeLessThan(output.markdown.indexOf("## CloudWatch"));
	expect(output.markdown).toContain("Not measured by oha");
	expect(output.markdown).toContain("500.00");
	expect(output.markdown).toContain("cold-start-times.svg");
	expect(output.throughputSvg).toContain("100.00");
	expect(output.coldSvg).toContain("500.00");
	expect(enhanceOhaMarkdown(output.markdown,report,coldSource).markdown).toBe(output.markdown);
});

test("cold samples from another region are not reused and missing data is not invented", () => {
	const output = enhanceOhaMarkdown(markdown, report, { ...coldSource, region: "us-east-1" });
	expect(output.markdown).toContain("No matching verified AWS cold-start samples");
	expect(output.coldSvg).toBeNull();
});

test("SVG graphs are accessible, zero-based, best-first, escape labels and include all trial points", () => {
	const svg = barChartSvg({ title: "Cold & startup", subtitle: "Lower is better", unit: "ms", higherIsBetter: false,
		rows: [{ label: "slow<bad>", value: 500, samples: [400,600] }, { label: "fast", value: 100, samples: [90,110] }] });
	expect(svg).toContain('role="img"');
	expect(svg).toContain("Cold &amp; startup");
	expect(svg).not.toContain("slow<bad>");
	expect(svg.indexOf(">fast</text>")).toBeLessThan(svg.indexOf(">slow&lt;bad&gt;</text>"));
	expect(svg).toContain('data-domain-min="0"');
	expect(svg.match(/data-sample=/g)).toHaveLength(4);
});
