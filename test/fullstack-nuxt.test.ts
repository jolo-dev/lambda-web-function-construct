import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { builtinModules, createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NuxtExampleStack } from "../examples/fullstack/nuxt/stack";
import {
	assertServerRendered,
	getBounded,
	postJson,
	readAsset,
	type RunningServer,
	startServer,
} from "../examples/fullstack/shared/probe";

// Artifact produced by `bash examples/fullstack/shared/build-native.sh examples/fullstack/nuxt -- node build-artifact.mjs`.
// This suite tests that host-native output only.
const EXAMPLE_ROOT = path.join(import.meta.dir, "..", "examples", "fullstack", "nuxt");
const ARTIFACT_ROOT = path.join(
	import.meta.dir,
	"..",
	"examples",
	"fullstack",
	"artifacts",
	"nuxt",
	`native-${process.platform}-${process.arch}`,
);
const BUILD_HINT = "run: bash examples/fullstack/shared/build-native.sh examples/fullstack/nuxt -- node build-artifact.mjs";

function requireArtifact(): void {
	if (!existsSync(path.join(ARTIFACT_ROOT, "index.js"))) {
		throw new Error(`Nuxt artifact missing at ${ARTIFACT_ROOT}; ${BUILD_HINT}`);
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
	const literal = /require\(\s*["']([^"']+)["']\s*\)/g;
	const realRoot = realpathSync(root);
	const unresolved: string[] = [];
	for (const file of files) {
		const contents = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const requireFromFile = createRequire(file);
		for (const match of contents.matchAll(literal)) {
			const specifier = match[1] ?? "";
			try {
				const resolved = requireFromFile.resolve(specifier);
				if (!resolved.startsWith("node:") && !resolved.startsWith(realRoot) && !builtinModules.includes(resolved)) {
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
	if (server === undefined) throw new Error("Nuxt server is not running");
	return server.baseUrl;
}

function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function runLauncher(endpoint: string | undefined): Promise<{ code: number | null; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.AWS_LAMBDA_HTTP_ENDPOINT;
	delete env.HOST;
	delete env.PORT;
	delete env.NITRO_HOST;
	delete env.NITRO_PORT;
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
	workDirectory = mkdtempSync(path.join(tmpdir(), "nuxt-artifact-"));
	const app = new App({ outdir: path.join(workDirectory, "cdk.out") });
	const stack = new NuxtExampleStack(app, "NuxtExample", { artifactDirectory: ARTIFACT_ROOT });
	stackTemplate = Template.fromStack(stack);
	zipPath = findZip(app.synth().directory, "index.js");
	if (zipPath === "") throw new Error("no revision ZIP containing index.js was synthesized");

	extractedRoot = path.join(workDirectory, "extracted");
	execFileSync("unzip", ["-q", zipPath, "-d", extractedRoot]);
	server = await startServer({
		command: ["node", "index.js"],
		cwd: extractedRoot,
		host: "127.0.0.1",
		port: await reserveFreePort(),
		startupTimeoutMs: 60_000,
	});
}, 120_000);

afterAll(async () => {
	await server?.stop();
	if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
});

describe("staged Nuxt node-server artifact", () => {
	test("stages a root launcher and the complete Nitro .output tree with the resolved server entry", () => {
		requireArtifact();
		const required = [
			"index.js",
			".output/server/index.mjs",
			".output/public",
		];
		for (const relative of required) {
			expect(existsSync(path.join(ARTIFACT_ROOT, relative)), relative).toBe(true);
		}
		expect(statSync(path.join(ARTIFACT_ROOT, ".output", "server")).isDirectory()).toBe(true);
		// Nitro server runtime chunks live under .output/server/chunks (or similar); at least one .mjs besides index exists.
		const serverFiles = listFiles(path.join(ARTIFACT_ROOT, ".output", "server"), ".mjs");
		expect(serverFiles.length).toBeGreaterThan(1);
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain(".output/server/index.mjs");
	});

	test("provides a content-hashed client asset prefix under .output/public for S3 staging", () => {
		requireArtifact();
		const nuxtAssets = path.join(ARTIFACT_ROOT, ".output", "public", "_nuxt");
		expect(existsSync(nuxtAssets), "_nuxt directory").toBe(true);
		expect(statSync(nuxtAssets).isDirectory()).toBe(true);
		const assetFiles = [
			...listFiles(nuxtAssets, ".js"),
			...listFiles(nuxtAssets, ".mjs"),
			...listFiles(nuxtAssets, ".css"),
		];
		expect(assetFiles.length, "hashed client assets under _nuxt").toBeGreaterThan(0);
	});

	test("keeps mutable/unhashed public files in the artifact (served dynamically)", () => {
		requireArtifact();
		expect(existsSync(path.join(ARTIFACT_ROOT, ".output", "public", "robots.txt"))).toBe(true);
	});
});

describe("extracted Nuxt Web Function ZIP", () => {
	test("synthesizes the stack with the launcher entrypoint and /_nuxt/ routed to S3", () => {
		expect(zipPath).toEndWith(".zip");
		expect(readdirSync(extractedRoot)).toContain("index.js");
		stackTemplate?.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
			ServiceConfig: {
				EnvironmentVariables: {
					AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.js",
					// The NuxtWebFunction construct sets NODE_ENV=production by default
					// (spec §5.7: a functional no-op for the standalone Nitro build).
					NODE_ENV: "production",
				},
			},
			BuildConfig: { RuntimeConfig: { Runtime: "nodejs24.x" } },
		});
		const distributions = Object.values(stackTemplate?.findResources("AWS::CloudFront::Distribution") ?? {});
		expect(distributions).toHaveLength(1);
		const config = (distributions[0] as { Properties: { DistributionConfig: DistributionConfigShape } }).Properties
			.DistributionConfig;
		const s3Origins = new Set(config.Origins.filter((origin) => origin.S3OriginConfig !== undefined).map((origin) => origin.Id));
		const httpOrigins = new Set(config.Origins.filter((origin) => origin.CustomOriginConfig !== undefined).map((origin) => origin.Id));
		const staticBehavior = config.CacheBehaviors?.find((behavior) => behavior.PathPattern === "/_nuxt/*");
		expect(staticBehavior && s3Origins.has(staticBehavior.TargetOriginId)).toBe(true);
		expect(httpOrigins.has(config.DefaultCacheBehavior.TargetOriginId)).toBe(true);
	});

	test("resolves every literal server-side require from Nitro's own server output", () => {
		const serverDir = path.join(extractedRoot, ".output", "server");
		const files = [
			path.join(serverDir, "index.mjs"),
			...listFiles(path.join(serverDir, "chunks"), ".js"),
			...listFiles(path.join(serverDir, "chunks"), ".cjs"),
			...listFiles(path.join(serverDir, "chunks"), ".mjs"),
		].filter((file) => existsSync(file));
		// Nitro node-server is ESM; if Nitro's own output contains no CommonJS require() calls there is nothing to resolve.
		if (files.length === 0) return;
		const literal = /require\(\s*["']([^"']+)["']\s*\)/g;
		if (!files.some((file) => literal.test(readFileSync(file, "utf8")))) return;
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
			// Nitro reports EADDRINUSE as an uncaughtException and may exit 0; either a failed exit or the bind error is required.
			expect(result.code !== 0 || /EADDRINUSE|EADDRINUSE/i.test(result.stderr)).toBe(true);
			expect(result.stderr).toContain("EADDRINUSE");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 30_000);
});

describe("running the extracted Nuxt artifact", () => {
	test("renders request-time SSR text in the first HTML response without client JavaScript", async () => {
		const before = Date.now();
		await assertServerRendered(baseUrl(), "/", "Rendered on the server at");
		const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		const rendered = /Rendered on the server at ([^<]+)</.exec(html)?.[1];
		expect(rendered).toBeDefined();
		const timestamp = Date.parse((rendered ?? "").trim());
		expect(timestamp).toBeGreaterThanOrEqual(before - 1_000);
		expect(timestamp).toBeLessThanOrEqual(Date.now() + 1_000);
	});

	test("a native Nitro server mutation validates input and returns a computed result", async () => {
		const valid = await postJson(baseUrl(), "/api/square", { value: "7" }, { timeoutMs: 10_000 });
		expect(valid.status).toBe(200);
		expect(valid.json).toEqual({ result: "7 squared is 49" });
	});

	test("the same server mutation rejects invalid input on the server", async () => {
		const invalid = await postJson(baseUrl(), "/api/square", { value: "not-a-number" }, { timeoutMs: 10_000 });
		expect(invalid.status).toBe(400);
		expect(invalid.json).toEqual({ error: "Enter a whole number from 0 to 1000" });
	});

	test("the second page is reachable for client navigation", async () => {
		const home = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(home).toContain('href="/about"');
		await assertServerRendered(baseUrl(), "/about", "About this example");
	});

	test("serves a hashed client asset from /_nuxt/ with cache headers", async () => {
		const nuxtAssets = path.join(extractedRoot, ".output", "public", "_nuxt");
		const assetFile = [...listFiles(nuxtAssets, ".js"), ...listFiles(nuxtAssets, ".mjs"), ...listFiles(nuxtAssets, ".css")][0] ?? "";
		const relative = path.relative(nuxtAssets, assetFile).split(path.sep).join("/");
		const asset = await readAsset(baseUrl(), `/_nuxt/${relative}`);
		expect(asset.status).toBe(200);
		expect(asset.body.byteLength).toBeGreaterThan(0);
		// Nitro/node-server typically serves built assets with immutable caching; assert a cache-control header is present.
		expect(asset.cacheControl).toBeTruthy();
	});

	test("serves a mutable/unhashed public file from the dynamic origin path", async () => {
		const asset = await readAsset(baseUrl(), "/robots.txt");
		expect(asset.status).toBe(200);
		expect(new TextDecoder().decode(asset.body)).toContain("User-agent");
	});
});

interface DistributionConfigShape {
	readonly Origins: readonly { readonly Id: string; readonly S3OriginConfig?: unknown; readonly CustomOriginConfig?: unknown }[];
	readonly DefaultCacheBehavior: { readonly TargetOriginId: string };
	readonly CacheBehaviors?: readonly { readonly PathPattern: string; readonly TargetOriginId: string }[];
}
