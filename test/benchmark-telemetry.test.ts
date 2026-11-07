import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveLogs, readLogGroups } from "../examples/benchmark/telemetry-artifacts";

test("CloudWatch events are retained losslessly in a compressed artifact", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "bench-logs-"));
	try {
		const logGroups = { "/aws/lambda/test": [{ message: "REPORT RequestId: test", timestamp: 123 }] };
		const result = archiveLogs({ metrics: [], logGroups }, directory, "test");
		expect(result.logGroups).toBeUndefined();
		expect(result.logArchive.sha256).toHaveLength(64);
		expect(readLogGroups(result, directory)).toEqual(logGroups);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
