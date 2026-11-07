import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateMarkdown, generateHtml } from "../examples/benchmark/report";

const data = JSON.parse(readFileSync(new URL("../examples/benchmark/results/latest.json", import.meta.url), "utf8"));
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
	expect(html).not.toContain("64 Separate Cold Starts");
});
