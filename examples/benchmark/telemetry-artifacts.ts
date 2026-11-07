import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export function archiveLogs(telemetry: any, directory: string, id: string): any {
	if (!telemetry?.logGroups) return telemetry;
	const { logGroups, ...summary } = telemetry;
	const bytes = gzipSync(JSON.stringify(logGroups));
	const filename = `aws-cloudwatch-${id}.json.gz`;
	writeFileSync(path.join(directory, filename), bytes);
	return { ...summary, logArchive: {
		path: filename, encoding: "gzip", bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		eventCounts: Object.fromEntries(Object.entries(logGroups).map(([name, events]) => [name, (events as unknown[]).length])),
	} };
}
export function readLogGroups(telemetry: any, directory: string): Record<string, any[]> {
	if (telemetry?.logGroups) return telemetry.logGroups;
	if (!telemetry?.logArchive) return {};
	const archive = readFileSync(path.join(directory, telemetry.logArchive.path));
	if (createHash("sha256").update(archive).digest("hex") !== telemetry.logArchive.sha256) throw new Error("CloudWatch archive checksum mismatch");
	return JSON.parse(gunzipSync(archive).toString("utf8"));
}
