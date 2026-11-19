import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	assertServerRendered,
	assertStreamsIncrementally,
	getBounded,
	inspectPage,
	postJson,
	readAsset,
	type RunningServer,
	type ServerStartOptions,
	verifyIdentity,
	withServer,
} from "../examples/fullstack/shared/probe";

// A stand-in for a framework launcher. It honours AWS_LAMBDA_HTTP_ENDPOINT, reports READY:<port>,
// and echoes the probe marker from FULLSTACK_PROBE_MARKER on the identity route.
const FIXTURE_SERVER = `
import { createServer } from "node:http";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = process.env.FULLSTACK_PROBE_MARKER;
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "127.0.0.1:3000";
const separator = endpoint.lastIndexOf(":");
const host = endpoint.slice(0, separator);
const requestedPort = process.env.FIXTURE_IGNORE_ENDPOINT === "1" ? 0 : Number(endpoint.slice(separator + 1));

if (process.env.FIXTURE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://fixture");
  if (pathname === "/__probe/identity") return sendJson(res, 200, { marker, port: server.address().port });
  if (pathname === "/ssr") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end('<!doctype html><html><body><h1>SSR marker text</h1><script type="module" src="/assets/app.js"></script></body></html>');
  }
  if (pathname === "/client-only") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end('<!doctype html><html><body><div id="root"></div><script>document.getElementById("root").textContent = ["client", "only", "text"].join("-");</script></body></html>');
  }
  if (pathname === "/assets/app.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" });
    return res.end("console.log('asset');");
  }
  if (pathname === "/mutation") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return sendJson(res, 200, { received: JSON.parse(raw).name, ok: true });
  }
  if (pathname === "/stream") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("chunk-1");
    await delay(400);
    return res.end("chunk-2");
  }
  if (pathname === "/buffered") {
    await delay(400);
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("chunk-1chunk-2");
  }
  if (pathname === "/hang") return;
  sendJson(res, 404, { error: "not found" });
});

if (process.env.FIXTURE_NEVER_READY === "1") {
  setInterval(() => {}, 1000);
} else {
  server.listen(requestedPort, host, () => process.stdout.write("READY:" + server.address().port + "\\n"));
}
`;

let fixtureDir: string;
let fixturePath: string;

beforeAll(() => {
	fixtureDir = mkdtempSync(path.join(tmpdir(), "fullstack-probe-"));
	fixturePath = path.join(fixtureDir, "server.mjs");
	writeFileSync(fixturePath, FIXTURE_SERVER);
});

afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function startOptions(env: Record<string, string> = {}, port = 0): ServerStartOptions {
	return {
		command: ["node", fixturePath],
		cwd: fixtureDir,
		host: "127.0.0.1",
		port,
		env,
		startupTimeoutMs: 10_000,
		requestTimeoutMs: 2_000,
		stopGraceMs: 500,
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A server that answers the identity route with its real port and the given marker, but was not started by the probe. */
async function startFakeServer(marker: string): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		if (req.url === "/__probe/identity") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ marker, port: (server.address() as AddressInfo).port }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("spawned server lifecycle", () => {
	test("starts on a nondefault host and port and verifies its identity", async () => {
		await withServer(startOptions(), async (server: RunningServer) => {
			expect(server.port).toBeGreaterThan(0);
			expect(server.port).not.toBe(3000);
			expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
			const response = await getBounded(server.baseUrl, "/ssr", { timeoutMs: 2_000 });
			expect(response.status).toBe(200);
		});
	});

	test("kills the child when the probe throws", async () => {
		let pid = 0;
		await expect(
			withServer(startOptions(), async (server) => {
				pid = server.pid;
				throw new Error("probe assertion failed");
			}),
		).rejects.toThrow("probe assertion failed");
		expect(pid).toBeGreaterThan(0);
		expect(isAlive(pid)).toBe(false);
	});

	test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		let pid = 0;
		await expect(
			withServer(startOptions({ FIXTURE_IGNORE_SIGTERM: "1" }), async (server) => {
				pid = server.pid;
				throw new Error("probe failed after SIGTERM was ignored");
			}),
		).rejects.toThrow("probe failed after SIGTERM was ignored");
		expect(isAlive(pid)).toBe(false);
	});

	test("rejects a child that reports a port other than the requested one", async () => {
		await expect(
			withServer(startOptions({ FIXTURE_IGNORE_ENDPOINT: "1" }, 47_123), async () => undefined),
		).rejects.toThrow(/reported port .* but 47123 was requested/);
	});

	test("times out when the child never reports READY", async () => {
		await expect(
			withServer({ ...startOptions({ FIXTURE_NEVER_READY: "1" }), startupTimeoutMs: 300 }, async () => undefined),
		).rejects.toThrow(/did not report READY within 300ms/);
	});
});

describe("identity verification", () => {
	test("rejects a fake server answering on a port other than the expected one", async () => {
		const fake = await startFakeServer("impostor");
		try {
			const fakePort = Number(new URL(fake.baseUrl).port);
			await expect(
				verifyIdentity(fake.baseUrl, { port: fakePort + 1, marker: "expected" }),
			).rejects.toThrow(/not the expected port/);
		} finally {
			fake.server.close();
		}
	});

	test("rejects a fake server on the expected port that presents the wrong marker", async () => {
		const fake = await startFakeServer("impostor");
		try {
			const fakePort = Number(new URL(fake.baseUrl).port);
			await expect(
				verifyIdentity(fake.baseUrl, { port: fakePort, marker: "expected" }),
			).rejects.toThrow(/identity .* mismatch/);
		} finally {
			fake.server.close();
		}
	});
});

describe("HTTP probes", () => {
	test("times out a request that never completes", async () => {
		await withServer(startOptions(), async (server) => {
			await expect(getBounded(server.baseUrl, "/hang", { timeoutMs: 200 })).rejects.toThrow(
				/timed out after 200ms/,
			);
		});
	});

	test("accepts text in the first HTML response and rejects text added only by JavaScript", async () => {
		await withServer(startOptions(), async (server) => {
			const ssr = await inspectPage(server.baseUrl, "/ssr", "SSR marker text");
			expect(ssr).toEqual({ status: 200, serverRendered: true });

			const clientOnly = await inspectPage(server.baseUrl, "/client-only", "client-only-text");
			expect(clientOnly).toEqual({ status: 200, serverRendered: false });

			await expect(
				assertServerRendered(server.baseUrl, "/client-only", "client-only-text"),
			).rejects.toThrow(/without executing JavaScript/);
			await assertServerRendered(server.baseUrl, "/ssr", "SSR marker text");
		});
	});

	test("returns the response to a JSON mutation", async () => {
		await withServer(startOptions(), async (server) => {
			const response = await postJson(server.baseUrl, "/mutation", { name: "probe" });
			expect(response).toEqual({ status: 200, json: { received: "probe", ok: true } });
			const rejected = await getBounded(server.baseUrl, "/mutation");
			expect(rejected.status).toBe(405);
		});
	});

	test("reads a static asset with its headers and enforces the byte cap", async () => {
		await withServer(startOptions(), async (server) => {
			const asset = await readAsset(server.baseUrl, "/assets/app.js", { maxBytes: 1024 });
			expect(asset.status).toBe(200);
			expect(asset.contentType).toContain("javascript");
			expect(asset.cacheControl).toBe("public, max-age=31536000, immutable");
			expect(new TextDecoder().decode(asset.body)).toBe("console.log('asset');");

			await expect(readAsset(server.baseUrl, "/assets/app.js", { maxBytes: 4 })).rejects.toThrow(
				/exceeds 4 bytes/,
			);
		});
	});

	test("accepts a streamed response whose first chunk arrives before the end", async () => {
		await withServer(startOptions(), async (server) => {
			const timing = await assertStreamsIncrementally(server.baseUrl, "/stream", {
				minimumGapMs: 150,
				timeoutMs: 2_000,
			});
			expect(timing.chunks).toBeGreaterThanOrEqual(2);
			expect(timing.gapMs).toBeGreaterThanOrEqual(150);
		});
	});

	test("rejects a response that arrives only at end-of-stream", async () => {
		await withServer(startOptions(), async (server) => {
			await expect(
				assertStreamsIncrementally(server.baseUrl, "/buffered", { minimumGapMs: 150, timeoutMs: 2_000 }),
			).rejects.toThrow(/not incremental/);
		});
	});
});
