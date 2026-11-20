import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { builtinModules, createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AstroExampleStack } from "../examples/fullstack/astro/stack";
import {
	assertServerRendered,
	getBounded,
	postJson,
	readAsset,
	type RunningServer,
	startServer,
} from "../examples/fullstack/shared/probe";

// Artifact produced by `cd examples/fullstack/astro && bun run build:artifact`
// (build-native.sh staging `astro build` output plus the runtime node_modules subtree).
// This suite tests that host-native output only.
const ARTIFACT_ROOT = path.join(
	import.meta.dir,
	"..",
	"examples",
	"fullstack",
	"artifacts",
	"astro",
	`native-${process.platform}-${process.arch}`,
);
const BUILD_HINT = "run: cd examples/fullstack/astro && bun run build:artifact";

function requireArtifact(): void {
	if (!existsSync(path.join(ARTIFACT_ROOT, "index.js"))) {
		throw new Error(`Astro artifact missing at ${ARTIFACT_ROOT}; ${BUILD_HINT}`);
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

function listDirectories(directory: string, name: string): string[] {
	if (!existsSync(directory)) return [];
	const matches: string[] = [];
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (!item.isDirectory()) continue;
		const fullPath = path.join(directory, item.name);
		if (item.name === name) matches.push(fullPath);
		matches.push(...listDirectories(fullPath, name));
	}
	return matches;
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
	if (server === undefined) throw new Error("Astro server is not running");
	return server.baseUrl;
}

function runLauncher(endpoint: string | undefined): Promise<{ code: number | null; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.AWS_LAMBDA_HTTP_ENDPOINT;
	delete env.HOST;
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
		// A spawn failure emits "error" without "exit"; treat it as a failure exit
		// (same handling as examples/fullstack/shared/probe.ts).
		child.once("error", () => {
			clearTimeout(deadline);
			resolve({ code: null, stderr });
		});
	});
}

/**
 * Unlike Nuxt — whose probe route lives in the app itself — the Astro launcher
 * hosts /__probe/identity, so the no-marker case needs its own spawn: start the
 * launcher WITHOUT FULLSTACK_PROBE_MARKER, wait for its READY line, probe the
 * identity route once, and always stop the child.
 */
function probeIdentityWithoutMarker(): Promise<{ status: number | null; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.AWS_LAMBDA_HTTP_ENDPOINT;
	delete env.FULLSTACK_PROBE_MARKER;
	env.AWS_LAMBDA_HTTP_ENDPOINT = "127.0.0.1:0";
	const child = spawn("node", ["index.js"], { cwd: extractedRoot, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const ready = new Promise<number>((resolve, reject) => {
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			const match = /READY:(\d+)\n/.exec(stdout);
			if (match) resolve(Number(match[1]));
		});
		child.once("exit", (code, signal) => reject(new Error(`launcher exited before READY (code ${code}, signal ${signal}); stderr: ${stderr}`)));
		// A spawn failure can emit "error" without "exit"; reject instead of hanging
		// until the deadline (same handling as examples/fullstack/shared/probe.ts).
		child.once("error", (cause) => reject(cause));
	});
	return (async () => {
		try {
			const port = await ready;
			const response = await getBounded(`http://127.0.0.1:${port}`, "/__probe/identity", { timeoutMs: 5_000 });
			return { status: response.status, stderr };
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 2_000);
			}
			await exited;
		}
	})();
}

let extractedRoot = "";
let server: RunningServer | undefined;
let stackTemplate: Template | undefined;
let zipPath = "";
let workDirectory = "";

beforeAll(async () => {
	requireArtifact();
	workDirectory = mkdtempSync(path.join(tmpdir(), "astro-artifact-"));
	const app = new App({ outdir: path.join(workDirectory, "cdk.out") });
	const stack = new AstroExampleStack(app, "AstroExample", { artifactDirectory: ARTIFACT_ROOT });
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
		startupTimeoutMs: 60_000,
	});
}, 120_000);

afterAll(async () => {
	await server?.stop();
	if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
});

describe("staged Astro node-server artifact", () => {
	test("stages a root launcher, the SSR server entry, hashed client assets, and the runtime packages", () => {
		requireArtifact();
		for (const relative of ["index.js", "dist/server/entry.mjs", "dist/client/_astro"]) {
			expect(existsSync(path.join(ARTIFACT_ROOT, relative)), relative).toBe(true);
		}
		expect(statSync(path.join(ARTIFACT_ROOT, "dist", "server")).isDirectory()).toBe(true);
		// The server bundle keeps astro external; the staged node_modules subtree is what
		// lets the extracted Web Function artifact resolve it without rebundling.
		expect(statSync(path.join(ARTIFACT_ROOT, "node_modules", "astro")).isDirectory()).toBe(true);
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("dist/server/entry.mjs");
	});

	test("provides a content-hashed client asset prefix under dist/client/_astro for S3 staging", () => {
		requireArtifact();
		const astroAssets = path.join(ARTIFACT_ROOT, "dist", "client", "_astro");
		expect(statSync(astroAssets, { throwIfNoEntry: false })?.isDirectory(), "_astro directory").toBe(true);
		const assetFiles = [
			...listFiles(astroAssets, ".js"),
			...listFiles(astroAssets, ".mjs"),
			...listFiles(astroAssets, ".css"),
		];
		expect(assetFiles.length, "hashed client assets under _astro").toBeGreaterThan(0);
	});

	test("stages no .bin directories in the artifact node_modules", () => {
		requireArtifact();
		expect(listDirectories(path.join(ARTIFACT_ROOT, "node_modules"), ".bin")).toEqual([]);
	});
});

describe("extracted Astro Web Function ZIP", () => {
	test("synthesizes the stack with the launcher entrypoint and /_astro/ routed to S3", () => {
		expect(zipPath).toEndWith(".zip");
		expect(readdirSync(extractedRoot)).toContain("index.js");
		stackTemplate?.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
			ServiceConfig: {
				EnvironmentVariables: {
					AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.js",
					// The AstroWebFunction construct sets NODE_ENV=production by default
					// (spec §5.7: Astro's standalone server output does not read it at runtime).
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
		const staticBehavior = config.CacheBehaviors?.find((behavior) => behavior.PathPattern === "/_astro/*");
		expect(staticBehavior && s3Origins.has(staticBehavior.TargetOriginId)).toBe(true);
		expect(httpOrigins.has(config.DefaultCacheBehavior.TargetOriginId)).toBe(true);
	});

	test("resolves every literal server-side require from Astro's own server output", () => {
		const serverDir = path.join(extractedRoot, "dist", "server");
		const files = [
			...listFiles(serverDir, ".js"),
			...listFiles(serverDir, ".cjs"),
			...listFiles(serverDir, ".mjs"),
		];
		// Astro's server bundle is ESM; if its own output contains no literal require()
		// calls there is nothing to resolve.
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
			expect(result.code !== 0 || /EADDRINUSE/i.test(result.stderr)).toBe(true);
			expect(result.stderr).toContain("EADDRINUSE");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 30_000);
});

describe("running the extracted Astro artifact", () => {
	test("renders request-time SSR text in the first HTML response without client JavaScript", async () => {
		const before = Date.now();
		await assertServerRendered(baseUrl(), "/", "Rendered on the server at");
		const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(html).toContain("Astro SSR on a Lambda Web Function");
		const rendered = /Rendered on the server at (?:<!-- -->)?\s*([^<]+)</.exec(html)?.[1];
		expect(rendered).toBeDefined();
		const timestamp = Date.parse((rendered ?? "").replace(/<!--.*?-->/g, "").trim());
		expect(Number.isNaN(timestamp)).toBe(false);
		expect(timestamp).toBeGreaterThanOrEqual(before - 1_000);
		expect(timestamp).toBeLessThanOrEqual(Date.now() + 1_000);
	});

	test("a native server API route validates input and returns a computed result", async () => {
		const valid = await postJson(baseUrl(), "/api/square", { value: 7 }, { timeoutMs: 10_000 });
		expect(valid.status).toBe(200);
		expect(valid.json).toEqual({ result: 49 });
	});

	test("the same API route rejects invalid input on the server", async () => {
		const invalid = await postJson(baseUrl(), "/api/square", { value: -1 }, { timeoutMs: 10_000 });
		expect(invalid.status).toBe(400);
		expect(invalid.json).toEqual({ error: "Value must be a number from 0 to 1000" });
	});

	test("the second page is reachable for navigation", async () => {
		const home = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(home).toContain('href="/about"');
		await assertServerRendered(baseUrl(), "/about", "A minimal Astro app rendered on a Lambda Web Function");
	});

	test("serves a hashed client asset from /_astro/ with immutable cache headers and a content type", async () => {
		const astroAssets = path.join(extractedRoot, "dist", "client", "_astro");
		const assetFile = [...listFiles(astroAssets, ".js"), ...listFiles(astroAssets, ".mjs"), ...listFiles(astroAssets, ".css")][0] ?? "";
		const relative = path.relative(astroAssets, assetFile).split(path.sep).join("/");
		const asset = await readAsset(baseUrl(), `/_astro/${relative}`);
		expect(asset.status).toBe(200);
		expect(asset.body.byteLength).toBeGreaterThan(0);
		expect(asset.cacheControl).toContain("immutable");
		expect(asset.contentType).toBeTruthy();
	});

	test("serves a mutable/unhashed public file from the dynamic origin path", async () => {
		const asset = await readAsset(baseUrl(), "/robots.txt");
		expect(asset.status).toBe(200);
		expect(asset.contentType).toContain("text/plain");
		expect(new TextDecoder().decode(asset.body)).toContain("User-agent");
	});

	test("the launcher-hosted probe route returns 404 when the marker is absent", async () => {
		const result = await probeIdentityWithoutMarker();
		expect(result.status).toBe(404);
	}, 30_000);
});

interface DistributionConfigShape {
	readonly Origins: readonly { readonly Id: string; readonly S3OriginConfig?: unknown; readonly CustomOriginConfig?: unknown }[];
	readonly DefaultCacheBehavior: { readonly TargetOriginId: string };
	readonly CacheBehaviors?: readonly { readonly PathPattern: string; readonly TargetOriginId: string }[];
}
