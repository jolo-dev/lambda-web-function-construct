import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TanStackStartExampleStack } from "../examples/fullstack/tanstack-start/stack";
import {
	assertServerRendered,
	getBounded,
	postJson,
	readAsset,
	type RunningServer,
	startServer,
} from "../examples/fullstack/shared/probe";

const EXAMPLE_ROOT = path.join(import.meta.dir, "..", "examples", "fullstack", "tanstack-start");
const TEST_SESSION_PASSWORD = "fullstack-demo-session-password-2026";
const ARTIFACT_ROOT = path.join(
	import.meta.dir,
	"..",
	"examples",
	"fullstack",
	"artifacts",
	"tanstack-start",
	`native-${process.platform}-${process.arch}`,
);
const BUILD_HINT = "run: cd examples/fullstack/tanstack-start && bun run build:artifact";

function requireArtifact(): void {
	if (!existsSync(path.join(ARTIFACT_ROOT, "index.js"))) {
		throw new Error(`TanStack Start artifact missing at ${ARTIFACT_ROOT}; ${BUILD_HINT}`);
	}
}

function findZip(directory: string, entry: string): string {
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, item.name);
		if (item.isDirectory()) {
			const nested = findZip(fullPath, entry);
			if (nested) return nested;
		} else if (item.isFile() && item.name.endsWith(".zip")) {
			const listing = execFileSync("unzip", ["-Z1", fullPath], { encoding: "utf8" });
			if (listing.split(/\r?\n/).some((line) => line.replace(/^\.\//, "") === entry)) return fullPath;
		}
	}
	return "";
}

function listFiles(directory: string, extension: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
		const fullPath = path.join(directory, item.name);
		if (item.isDirectory()) return listFiles(fullPath, extension);
		return item.isFile() && item.name.endsWith(extension) ? [fullPath] : [];
	});
}

function unresolvedRequires(root: string, files: readonly string[]): string[] {
	const literal = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
	const realRoot = realpathSync(root);
	const unresolved: string[] = [];
	for (const file of files) {
		const contents = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		if (!literal.test(contents)) continue;
		literal.lastIndex = 0;
		const requireFromFile = createRequire(file);
		for (const match of contents.matchAll(literal)) {
			const specifier = match[1] ?? "";
			try {
				const resolved = requireFromFile.resolve(specifier);
				if (!resolved.startsWith("node:") && !resolved.startsWith(realRoot)) {
					unresolved.push(`${path.relative(realRoot, file)} -> ${specifier} (resolved outside root: ${resolved})`);
				}
			} catch {
				unresolved.push(`${path.relative(realRoot, file)} -> ${specifier}`);
			}
		}
	}
	return unresolved;
}

function baseUrl(): string {
	if (server === undefined) throw new Error("TanStack Start server is not running");
	return server.baseUrl;
}

function runLauncher(endpoint: string | undefined): Promise<{ code: number | null; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.AWS_LAMBDA_HTTP_ENDPOINT;
	delete env.HOST;
	delete env.HOSTNAME;
	delete env.PORT;
	if (endpoint !== undefined) env.AWS_LAMBDA_HTTP_ENDPOINT = endpoint;
	const child = spawn("node", ["index.js"], { cwd: extractedRoot, env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
	return new Promise((resolve) => {
		child.once("exit", (code) => {
			clearTimeout(deadline);
			resolve({ code, stderr });
		});
	});
}

let extractedRoot = "";
let server: RunningServer | undefined;
let stackTemplate: Template | undefined;
let zipPath = "";
let workDirectory = "";

beforeAll(async () => {
	requireArtifact();
	workDirectory = mkdtempSync(path.join(tmpdir(), "tanstack-artifact-"));
	const app = new App({ outdir: path.join(workDirectory, "cdk.out") });
	const stack = new TanStackStartExampleStack(app, "TanStackStartExample", {
		artifactDirectory: ARTIFACT_ROOT,
		sessionPassword: TEST_SESSION_PASSWORD,
	});
	stackTemplate = Template.fromStack(stack);
	zipPath = findZip(app.synth().directory, "index.js");
	if (zipPath === "") throw new Error("no revision ZIP containing index.js was synthesized");

	extractedRoot = path.join(workDirectory, "extracted");
	execFileSync("unzip", ["-q", zipPath, "-d", extractedRoot]);
	server = await startServer({
		command: ["node", "index.js"],
		cwd: extractedRoot,
		host: "127.0.0.1",
		port: 0,
		env: { SESSION_PASSWORD: TEST_SESSION_PASSWORD, NODE_ENV: "production" },
		startupTimeoutMs: 60_000,
	});
}, 300_000);

afterAll(async () => {
	await server?.stop();
	if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
});

describe("staged TanStack Start artifact", () => {
	test("stages a root launcher and the complete production dist tree with the discovered server entry", () => {
		requireArtifact();
		for (const relative of [
			"index.js",
			"package.json",
			"dist/server/server.js",
			"dist/client/assets",
			"dist/client/robots.txt",
		]) {
			expect(existsSync(path.join(ARTIFACT_ROOT, relative)), relative).toBe(true);
		}
		expect(statSync(path.join(ARTIFACT_ROOT, "dist", "server")).isDirectory()).toBe(true);
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("dist/server/server.js");
	});

	test("provides a content-hashed client asset under dist/client/assets for S3 staging", () => {
		requireArtifact();
		const assetsDir = path.join(ARTIFACT_ROOT, "dist", "client", "assets");
		const assetFiles = [
			...listFiles(assetsDir, ".js"),
			...listFiles(assetsDir, ".mjs"),
			...listFiles(assetsDir, ".css"),
		];
		expect(assetFiles.length, "hashed client assets under /assets").toBeGreaterThan(0);
	});

	test("keeps mutable/unhashed public files in the client output", () => {
		requireArtifact();
		expect(existsSync(path.join(ARTIFACT_ROOT, "dist", "client", "robots.txt"))).toBe(true);
	});
});

describe("extracted TanStack Start Web Function ZIP", () => {
	test("synthesizes the stack with the launcher entrypoint and /assets/ routed to S3", () => {
		expect(zipPath).toEndWith(".zip");
		expect(readdirSync(extractedRoot)).toContain("index.js");
		stackTemplate?.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
			ServiceConfig: { EnvironmentVariables: { AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.js" } },
			BuildConfig: { RuntimeConfig: { Runtime: "nodejs24.x" } },
		});
		const distributions = Object.values(stackTemplate?.findResources("AWS::CloudFront::Distribution") ?? {});
		expect(distributions).toHaveLength(1);
		const config = (distributions[0] as { Properties: { DistributionConfig: DistributionConfigShape } }).Properties
			.DistributionConfig;
		const s3Origins = new Set(config.Origins.filter((origin) => origin.S3OriginConfig !== undefined).map((origin) => origin.Id));
		const httpOrigins = new Set(config.Origins.filter((origin) => origin.CustomOriginConfig !== undefined).map((origin) => origin.Id));
		const staticBehavior = config.CacheBehaviors?.find((behavior) => behavior.PathPattern === "/assets/*");
		expect(staticBehavior && s3Origins.has(staticBehavior.TargetOriginId)).toBe(true);
		expect(httpOrigins.has(config.DefaultCacheBehavior.TargetOriginId)).toBe(true);
	});

	test("extracted artifact contains dist output and launcher", () => {
		expect(existsSync(path.join(extractedRoot, "index.js"))).toBe(true);
		expect(existsSync(path.join(extractedRoot, "dist/server/server.js"))).toBe(true);
		expect(existsSync(path.join(extractedRoot, "dist/client/robots.txt"))).toBe(true);
	});

	test("resolves literal server-side require() calls in dist/server when present", () => {
		const serverDir = path.join(extractedRoot, "dist", "server");
		const files = [
			path.join(serverDir, "server.js"),
			...listFiles(path.join(serverDir, "assets"), ".js"),
			...listFiles(path.join(serverDir, "assets"), ".cjs"),
			...listFiles(path.join(serverDir, "assets"), ".mjs"),
		].filter((file) => existsSync(file));
		expect(unresolvedRequires(extractedRoot, files)).toEqual([]);
	});

	test("the launcher refuses an unparseable endpoint before starting the server", async () => {
		const result = await runLauncher("127.0.0.1:not-a-port");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
	});

	test("the launcher fails to start when its endpoint port is already bound", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
		const address = blocker.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			const result = await runLauncher(`127.0.0.1:${port}`);
			expect(result.code !== 0 || /EADDRINUSE/i.test(result.stderr)).toBe(true);
			expect(result.stderr).toContain("EADDRINUSE");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 30_000);
});

describe("running the extracted TanStack Start artifact", () => {
	test("renders request-time SSR text in the first HTML response without client JavaScript", async () => {
		const before = Date.now();
		await assertServerRendered(baseUrl(), "/", "Rendered on the server at");
		const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(html).toContain("TanStack Start on Lambda Web Function");
		const rendered = /Rendered on the server at (?:<!-- -->)?\s*([^<]+)</.exec(html)?.[1];
		expect(rendered).toBeDefined();
		const timestamp = Date.parse((rendered ?? "").replace(/<!--.*?-->/g, "").trim());
		expect(Number.isNaN(timestamp)).toBe(false);
		expect(timestamp).toBeGreaterThanOrEqual(before - 1_000);
		expect(timestamp).toBeLessThanOrEqual(Date.now() + 1_000);
	});

	test("a native server route mutation validates input and returns a computed result", async () => {
		const valid = await postJson(baseUrl(), "/api/square", { value: "12" }, { timeoutMs: 10_000 });
		expect(valid.status).toBe(200);
		expect(valid.json).toEqual({ result: "144" });
	});

	test("the same server route mutation rejects invalid input on the server", async () => {
		const invalid = await postJson(baseUrl(), "/api/square", { value: "-1" }, { timeoutMs: 10_000 });
		expect(invalid.status).toBe(400);
		expect((invalid.json as { error?: string }).error).toMatch(/number|0|1000/i);
	});

	test("the second page is reachable for navigation", async () => {
		const home = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(home).toContain('href="/about"');
		await assertServerRendered(baseUrl(), "/about", "About this example");
	});

	test("serves a hashed client asset from /assets/ with cache headers", async () => {
		const assetsDir = path.join(extractedRoot, "dist", "client", "assets");
		const assetFile = [...listFiles(assetsDir, ".js"), ...listFiles(assetsDir, ".mjs"), ...listFiles(assetsDir, ".css")][0] ?? "";
		const relative = path.relative(assetsDir, assetFile).split(path.sep).join("/");
		const asset = await readAsset(baseUrl(), `/assets/${relative}`);
		expect(asset.status).toBe(200);
		expect(asset.body.byteLength).toBeGreaterThan(0);
		expect(asset.cacheControl).toBeTruthy();
	});

	test("serves a mutable/unhashed public file from the dynamic origin path", async () => {
		const asset = await readAsset(baseUrl(), "/robots.txt");
		expect(asset.status).toBe(200);
		expect(new TextDecoder().decode(asset.body)).toContain("User-agent");
	});
});

test("stack wires the session secret and production cookie mode", () => {
	const app = new App();
	const stack = new TanStackStartExampleStack(app, "SessionEnvStack", {
		artifactDirectory: ARTIFACT_ROOT,
		sessionPassword: TEST_SESSION_PASSWORD,
	});
	Template.fromStack(stack).hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
		ServiceConfig: {
			EnvironmentVariables: {
				SESSION_PASSWORD: TEST_SESSION_PASSWORD,
				NODE_ENV: "production",
			},
		},
	});
});

test("stack rejects a short session password", () => {
	const app = new App();
	expect(() =>
		new TanStackStartExampleStack(app, "ShortSecretStack", {
			artifactDirectory: ARTIFACT_ROOT,
			sessionPassword: "too-short",
		})).toThrow(/at least 32 characters/);
});

interface DistributionConfigShape {
	readonly Origins: readonly { readonly Id: string; readonly S3OriginConfig?: unknown; readonly CustomOriginConfig?: unknown }[];
	readonly DefaultCacheBehavior: { readonly TargetOriginId: string };
	readonly CacheBehaviors?: readonly { readonly PathPattern: string; readonly TargetOriginId: string }[];
}
