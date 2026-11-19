import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { builtinModules, createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NextjsExampleStack } from "../examples/fullstack/nextjs/stack";
import {
	assertServerRendered,
	getBounded,
	readAsset,
	type RunningServer,
	startServer,
} from "../examples/fullstack/shared/probe";

// The artifact is produced by `bash examples/fullstack/shared/build-native.sh examples/fullstack/nextjs -- node build-artifact.mjs`.
// build-native.sh writes to artifacts/<workspace>/native-<platform>-<arch>; this suite tests that host-native output only.
const EXAMPLE_ROOT = path.join(import.meta.dir, "..", "examples", "fullstack", "nextjs");
const ARTIFACT_ROOT = path.join(
	import.meta.dir,
	"..",
	"examples",
	"fullstack",
	"artifacts",
	"nextjs",
	`native-${process.platform}-${process.arch}`,
);
const BUILD_HINT = "run: bash examples/fullstack/shared/build-native.sh examples/fullstack/nextjs -- node build-artifact.mjs";

function requireArtifact(): void {
	if (!existsSync(path.join(ARTIFACT_ROOT, "index.js"))) {
		throw new Error(`Next.js artifact missing at ${ARTIFACT_ROOT}; ${BUILD_HINT}`);
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

/**
 * Returns each literal require("...") specifier in `files` that does not resolve inside `root` (or to a builtin).
 * Comments are stripped first so that prose such as `require("something")` in runtime comments is not a dependency.
 */
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
	if (server === undefined) throw new Error("Next.js server is not running");
	return server.baseUrl;
}

/**
 * The launcher rejects port 0 (Next.js maps PORT=0 to 3000), so the test picks a concrete free port. The window
 * between release and bind is small; a collision fails startup, and the probe's identity check rejects a stranger.
 */
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
	workDirectory = mkdtempSync(path.join(tmpdir(), "nextjs-artifact-"));
	const app = new App({ outdir: path.join(workDirectory, "cdk.out") });
	const stack = new NextjsExampleStack(app, "NextjsExample", { artifactDirectory: ARTIFACT_ROOT });
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

describe("staged Next.js standalone artifact", () => {
	test("stages a root launcher, the standalone server, traced dependencies, manifests and public files", () => {
		requireArtifact();
		const required = [
			"index.js",
			"server.js",
			"package.json",
			"node_modules/next/package.json",
			".next/BUILD_ID",
			".next/required-server-files.json",
			".next/routes-manifest.json",
			".next/prerender-manifest.json",
			".next/build-manifest.json",
			"public/robots.txt",
		];
		for (const relative of required) {
			expect(existsSync(path.join(ARTIFACT_ROOT, relative)), relative).toBe(true);
		}
		expect(readFileSync(path.join(ARTIFACT_ROOT, "index.js"), "utf8")).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
	});

	test("provides the hashed .next/static tree for S3 staging", () => {
		requireArtifact();
		const staticDirectory = path.join(ARTIFACT_ROOT, ".next", "static");
		expect(statSync(staticDirectory).isDirectory()).toBe(true);
		expect(listFiles(path.join(staticDirectory, "chunks"), ".js").length).toBeGreaterThan(0);
	});
});

describe("extracted Next.js Web Function ZIP", () => {
	test("synthesizes the stack with the launcher entrypoint and a static-asset behavior routed to S3", () => {
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
		const staticBehavior = config.CacheBehaviors?.find((behavior) => behavior.PathPattern === "/_next/static/*");
		expect(staticBehavior && s3Origins.has(staticBehavior.TargetOriginId)).toBe(true);
		expect(httpOrigins.has(config.DefaultCacheBehavior.TargetOriginId)).toBe(true);
	});

	test("resolves every literal server-side require from the extracted root", () => {
		const files = [path.join(extractedRoot, "server.js"), ...listFiles(path.join(extractedRoot, ".next", "server"), ".js")];
		expect(files.length).toBeGreaterThan(1);
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
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("EADDRINUSE");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 30_000);
});

describe("running the extracted Next.js artifact", () => {
	test("renders request-time SSR text in the first HTML response without client JavaScript", async () => {
		const before = Date.now();
		await assertServerRendered(baseUrl(), "/", "Rendered on the server at");
		const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		const rendered = /Rendered on the server at (\S+?)</.exec(html)?.[1];
		expect(rendered).toBeDefined();
		const timestamp = Date.parse(rendered ?? "");
		expect(timestamp).toBeGreaterThanOrEqual(before - 1_000);
		expect(timestamp).toBeLessThanOrEqual(Date.now() + 1_000);
	});

	test("a native server action validates input and returns a computed result", async () => {
		const result = await submitSquareForm(baseUrl(), "7");
		expect(result.status).toBe(200);
		expect(result.html).toContain("7 squared is 49");
	});

	test("the same server action rejects invalid input on the server", async () => {
		const result = await submitSquareForm(baseUrl(), "not-a-number");
		expect(result.status).toBe(200);
		expect(result.html).toContain("Enter a whole number from 0 to 1000");
		expect(result.html).not.toContain("squared is");
	});

	test("the second page is reachable through an RSC client-navigation request", async () => {
		const home = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
		expect(home).toContain('href="/about"');
		const navigation = await getBounded(baseUrl(), "/about", { timeoutMs: 10_000 });
		expect(navigation.status).toBe(200);
		const flight = await fetch(new URL("/about", baseUrl()), {
			headers: { RSC: "1" },
			signal: AbortSignal.timeout(10_000),
		});
		expect(flight.status).toBe(200);
		expect(flight.headers.get("content-type")).toContain("text/x-component");
		expect(await flight.text()).toContain("About this example");
	});

	test("serves a hashed client chunk from .next/static with immutable caching", async () => {
		const chunk = listFiles(path.join(extractedRoot, ".next", "static", "chunks"), ".js")[0] ?? "";
		const relative = path.relative(path.join(extractedRoot, ".next", "static"), chunk).split(path.sep).join("/");
		const asset = await readAsset(baseUrl(), `/_next/static/${relative}`);
		expect(asset.status).toBe(200);
		expect(asset.contentType).toContain("javascript");
		expect(asset.cacheControl).toContain("immutable");
	});

	test("serves the public robots file from the artifact", async () => {
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

/**
 * Posts the square form the way a browser does without JavaScript: the hidden inputs rendered
 * with the form are echoed back with the user's value. Returns the re-rendered HTML.
 */
async function submitSquareForm(baseUrl: string, value: string): Promise<{ status: number; html: string }> {
	const page = new TextDecoder().decode((await getBounded(baseUrl, "/")).body);
	const body = new FormData();
	for (const match of page.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/?>/g)) {
		body.append(match[1] ?? "", decodeAttribute(match[2] ?? ""));
	}
	body.append("value", value);
	const response = await fetch(new URL("/", baseUrl), {
		method: "POST",
		body,
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	return { status: response.status, html: await response.text() };
}

function decodeAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}
