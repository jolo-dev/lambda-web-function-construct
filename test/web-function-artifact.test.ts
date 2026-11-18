import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { WebFunction, WebFunctionAuthType, WebFunctionEndpointType } from "../src";
import { zipArtifactDirectory } from "../src/web-function-artifact";

const fixture = mkdtempSync(path.join(tmpdir(), "web-function-artifact-"));
const artifactDirectory = path.join(fixture, "artifact");
mkdirSync(path.join(artifactDirectory, "nested"), { recursive: true });
writeFileSync(path.join(artifactDirectory, "index.mjs"), "export {};");
writeFileSync(path.join(artifactDirectory, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(path.join(artifactDirectory, "nested", "package.json"), JSON.stringify({ name: "nested-runtime" }));
writeFileSync(path.join(artifactDirectory, "nested", "runtime.mjs"), "export const answer = 42;");
symlinkSync(path.join("nested", "runtime.mjs"), path.join(artifactDirectory, "linked-runtime.mjs"));
symlinkSync("nested", path.join(artifactDirectory, "linked-directory"));
process.on("exit", () => rmSync(fixture, { recursive: true, force: true }));

const common = {
  functionName: "artifact-test",
  authType: WebFunctionAuthType.IAM_AUTH,
  endpointType: WebFunctionEndpointType.HOME_REGION,
  endpointName: "prod",
};

function synth(props: Record<string, unknown>) {
  const app = new App();
  const stack = new Stack(app, `Artifact${Math.random().toString(36).slice(2)}`);
  const webFunction = new WebFunction(stack, "App", props as never);
  return { webFunction, template: Template.fromStack(stack), assembly: app.synth() };
}

function findZip(directory: string): string {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findZip(fullPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".zip")) {
      const listing = execFileSync("unzip", ["-Z1", fullPath], { encoding: "utf8" });
      if (listing.split(/\r?\n/).some((item) => item.replace(/^\.\//, "") === "index.mjs")) return fullPath;
    }
  }
  return "";
}

test("packages a prebuilt artifact and exposes endpoint properties", () => {
  const { webFunction, template, assembly } = synth({
    ...common,
    artifact: { directory: artifactDirectory, entrypoint: "index.mjs" },
  });
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.mjs" } },
    BuildConfig: { RuntimeConfig: { Runtime: "nodejs24.x" } },
  });
  expect(webFunction.endpointArn).toBeTruthy();
  expect(webFunction.authType).toBe(WebFunctionAuthType.IAM_AUTH);
  expect(webFunction.endpointType).toBe(WebFunctionEndpointType.HOME_REGION);

  const zip = findZip(assembly.directory);
  expect(zip).not.toBe("");
  const extracted = mkdtempSync(path.join(tmpdir(), "web-function-zip-"));
  try {
    execFileSync("unzip", ["-q", zip, "-d", extracted]);
    expect(readdirSync(extracted)).toContain("index.mjs");
    expect(readdirSync(extracted)).toContain("package.json");
    expect(readFileSync(path.join(extracted, "package.json"), "utf8")).toContain('"type":"module"');
    expect(readFileSync(path.join(extracted, "nested", "package.json"), "utf8")).toContain("nested-runtime");
    expect(readFileSync(path.join(extracted, "nested", "runtime.mjs"), "utf8")).toContain("answer = 42");
    expect(readFileSync(path.join(extracted, "linked-runtime.mjs"), "utf8")).toContain("answer = 42");
    expect(readFileSync(path.join(extracted, "linked-directory", "runtime.mjs"), "utf8")).toContain("answer = 42");
    expect(lstatSync(path.join(extracted, "linked-runtime.mjs")).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(extracted, "linked-directory")).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(artifactDirectory, "linked-runtime.mjs")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(artifactDirectory, "linked-directory")).isSymbolicLink()).toBe(true);
    expect(readdirSync(extracted)).not.toContain("artifact");
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});

test("starts the extracted artifact using its configured entrypoint and endpoint", async () => {
  const source = mkdtempSync(path.join(tmpdir(), "web-function-runtime-source-"));
  const extracted = mkdtempSync(path.join(tmpdir(), "web-function-runtime-extracted-"));
  let child: ReturnType<typeof spawn> | undefined;
  let childError: Error | undefined;
  let stdout = "";
  let stderr = "";
  const isTerminal = () => child === undefined || child.exitCode !== null || child.signalCode !== null || childError !== undefined;
  const waitForTerminal = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (isTerminal()) return resolve(true);
    let done = false;
    const finish = (terminal: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child!.removeListener("exit", onTerminal);
      child!.removeListener("error", onTerminal);
      resolve(terminal);
    };
    const onTerminal = () => finish(true);
    const timer = setTimeout(() => finish(isTerminal()), timeoutMs);
    child!.once("exit", onTerminal);
    child!.once("error", onTerminal);
  });
  try {
    mkdirSync(path.join(source, "nested"));
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(source, "nested", "message.mjs"), 'export const message = "from nested artifact";');
    writeFileSync(path.join(source, "index.mjs"), [
      'import { createServer } from "node:http";',
      'import { message } from "./nested/message.mjs";',
      'const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "127.0.0.1:3000").split(":");',
      'const server = createServer((_request, response) => response.end(message));',
      'server.listen(Number(port), host, () => {',
      '  const address = server.address();',
      '  if (!address || typeof address === "string") throw new Error("No TCP address allocated");',
      '  process.stdout.write(`READY:${address.port}\\n`);',
      '});',
    ].join("\n"));

    const { assembly } = synth({ ...common, artifact: { directory: source, entrypoint: "index.mjs" } });
    const zip = findZip(assembly.directory);
    expect(zip).not.toBe("");
    const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split(/\r?\n/);
    expect(listing).toContain("index.mjs");
    expect(listing).toContain("nested/message.mjs");
    execFileSync("unzip", ["-q", zip, "-d", extracted]);
    expect(readFileSync(path.join(extracted, "index.mjs"), "utf8")).toContain('./nested/message.mjs');
    expect(statSync(path.join(extracted, "index.mjs")).mode & 0o777).toBe(0o644);
    child = spawn("node", ["index.mjs"], {
      cwd: extracted,
      env: { ...process.env, AWS_LAMBDA_HTTP_ENDPOINT: "127.0.0.1:0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => { childError = error; });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const startupDeadline = Date.now() + 3000;
    let port: number | undefined;
    while (Date.now() < startupDeadline && port === undefined) {
      if (childError) throw new Error(`Failed to spawn extracted server: ${childError.message}; stderr: ${stderr}`);
      if (child.exitCode !== null) throw new Error(`Extracted server exited (${child.exitCode}): ${stderr}`);
      const marker = stdout.match(/READY:(\d+)/);
      if (marker) port = Number(marker[1]);
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (port === undefined) throw new Error(`Extracted server readiness timed out; stdout: ${stdout}; stderr: ${stderr}`);

    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: port!, path: "/", method: "GET", timeout: 1000 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(data));
      });
      req.on("timeout", () => req.destroy(new Error("request timeout")));
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("from nested artifact");
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null && childError === undefined) {
        child.kill("SIGTERM");
        const exited = await waitForTerminal(1000);
        if (!exited && !isTerminal()) {
          child.kill("SIGKILL");
          const forceExited = await waitForTerminal(1000);
          if (!forceExited && !isTerminal()) {
            throw new Error("Extracted server remained alive after SIGKILL (1s exit deadline)");
          }
        }
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(extracted, { recursive: true, force: true });
    }
  }
});

test("legacy entry mode does not set an entrypoint variable", () => {
  const entry = path.join(fixture, "legacy.ts");
  writeFileSync(entry, "export {};");
  const { template } = synth({ ...common, entry });
  const revision = Object.values(template.findResources("AWS::Lambda::WebFunctionRevision"))[0];
  expect(JSON.stringify(revision)).not.toContain("AWS_LAMBDA_NODEJS_ENTRYPOINT");
});

test.each([
  ["neither mode", {}],
  ["both modes", { entry: path.join(fixture, "legacy.ts"), artifact: { directory: artifactDirectory, entrypoint: "index.mjs" } }],
  ["traversal", { artifact: { directory: artifactDirectory, entrypoint: "../outside.mjs" } }],
  ["absolute entrypoint", { artifact: { directory: artifactDirectory, entrypoint: path.join(artifactDirectory, "index.mjs") } }],
  ["missing entrypoint", { artifact: { directory: artifactDirectory, entrypoint: "missing.mjs" } }],
  ["reserved endpoint variable", { entry: path.join(fixture, "legacy.ts"), environmentVariables: { AWS_LAMBDA_HTTP_ENDPOINT: "bad" } }],
  ["conflicting entrypoint variable", { artifact: { directory: artifactDirectory, entrypoint: "index.mjs" }, environmentVariables: { AWS_LAMBDA_NODEJS_ENTRYPOINT: "other.mjs" } }],
])("rejects %s", (_name, props) => {
  expect(() => synth({ ...common, ...props })).toThrow();
});

test("rejects newline entry names and cleans up staging before ZIP creation", () => {
  const directory = mkdtempSync(path.join(fixture, "newline-artifact-"));
  const outputZip = path.join(fixture, "newline.zip");
  const stagedBefore = readdirSync(tmpdir()).filter((entry) => entry.startsWith("pawl-web-artifact-"));
  try {
    writeFileSync(path.join(directory, "bad\nname.txt"), "unsafe ZIP list path");
    let zipInvoked = false;
    expect(() => zipArtifactDirectory(directory, outputZip, () => { zipInvoked = true; })).toThrow(/newline|carriage return/i);
    expect(zipInvoked).toBe(false);
    expect(existsSync(outputZip)).toBe(false);
    expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("pawl-web-artifact-"))).toEqual(stagedBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outputZip, { force: true });
  }
});

test("rejects an artifact larger than 512 MiB before ZIP creation", () => {
  const directory = mkdtempSync(path.join(fixture, "oversized-artifact-"));
  const sparseFile = path.join(directory, "large.bin");
  const outputZip = path.join(fixture, "oversized.zip");
  try {
    writeFileSync(sparseFile, "");
    truncateSync(sparseFile, 512 * 1024 * 1024 + 1);
    let zipInvoked = false;
    let filesCopied = 0;
    expect(() => zipArtifactDirectory(
      directory,
      outputZip,
      () => { zipInvoked = true; },
      () => { filesCopied += 1; },
    )).toThrow(/512 MiB/);
    expect(zipInvoked).toBe(false);
    expect(filesCopied).toBe(0);
    expect(existsSync(outputZip)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outputZip, { force: true });
  }
});

test("creates byte-identical ZIPs for identical contents and changes hash when contents change", () => {
  const directory = mkdtempSync(path.join(fixture, "deterministic-artifact-"));
  const sourceFile = path.join(directory, "nested", "entry.js");
  const firstZip = path.join(fixture, "deterministic-one.zip");
  const secondZip = path.join(fixture, "deterministic-two.zip");
  const changedZip = path.join(fixture, "deterministic-changed.zip");
  try {
    mkdirSync(path.dirname(sourceFile));
    writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(sourceFile, "export const value = 1;\n");
    utimesSync(sourceFile, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    zipArtifactDirectory(directory, firstZip);
    utimesSync(sourceFile, new Date("2024-06-01T12:34:56Z"), new Date("2024-06-01T12:34:56Z"));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    zipArtifactDirectory(directory, secondZip);
    const hash = (archive: string) => createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(hash(secondZip)).toBe(hash(firstZip));

    writeFileSync(sourceFile, "export const value = 2;\n");
    zipArtifactDirectory(directory, changedZip);
    expect(hash(changedZip)).not.toBe(hash(secondZip));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    for (const archive of [firstZip, secondZip, changedZip]) rmSync(archive, { force: true });
  }
});

test("preserves source file and directory permission bits in the ZIP", () => {
  const directory = mkdtempSync(path.join(fixture, "permission-artifact-"));
  const restrictedDirectory = path.join(directory, "restricted");
  const executableFile = path.join(directory, "run.sh");
  const restrictedFile = path.join(restrictedDirectory, "secret.txt");
  const outputZip = path.join(fixture, "permissions.zip");
  const extracted = mkdtempSync(path.join(fixture, "permissions-extracted-"));
  try {
    mkdirSync(restrictedDirectory);
    writeFileSync(executableFile, "#!/bin/sh\\necho ok\\n");
    writeFileSync(restrictedFile, "private\\n");
    chmodSync(restrictedDirectory, 0o750);
    chmodSync(executableFile, 0o751);
    chmodSync(restrictedFile, 0o640);

    zipArtifactDirectory(directory, outputZip);
    execFileSync("unzip", ["-q", outputZip, "-d", extracted]);
    expect(statSync(path.join(extracted, "run.sh")).mode & 0o777).toBe(0o751);
    expect(statSync(path.join(extracted, "restricted")).mode & 0o777).toBe(0o750);
    expect(statSync(path.join(extracted, "restricted", "secret.txt")).mode & 0o777).toBe(0o640);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
    rmSync(outputZip, { force: true });
  }
});

test("stages internal file and directory symlinks as regular content", () => {
  const outputZip = path.join(fixture, "staged.zip");
  zipArtifactDirectory(artifactDirectory, outputZip, (args, cwd, input) => {
    expect(realpathSync(cwd)).not.toBe(realpathSync(artifactDirectory));
    expect(lstatSync(path.join(cwd, "linked-runtime.mjs")).isFile()).toBe(true);
    expect(lstatSync(path.join(cwd, "linked-directory")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(cwd, "linked-runtime.mjs"), "utf8")).toContain("answer = 42");
    execFileSync("zip", args, { cwd, input });
  });
  rmSync(outputZip, { force: true });
});

test.each([
  ["broken", "missing-target", "broken-link"],
  ["cyclic", "cycle-b", "cycle-a"],
])("rejects %s internal symlinks", (_name, target, linkName) => {
  const directory = mkdtempSync(path.join(fixture, "invalid-links-"));
  const outputZip = path.join(fixture, "invalid-links.zip");
  try {
    writeFileSync(path.join(directory, "index.mjs"), "export {};");
    if (linkName === "cycle-a") symlinkSync("cycle-a", path.join(directory, "cycle-b"));
    symlinkSync(target, path.join(directory, linkName));
    expect(() => zipArtifactDirectory(directory, outputZip)).toThrow();
    expect(existsSync(outputZip)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outputZip, { force: true });
  }
});

test("rejects non-regular entries in the artifact tree", () => {
  const directory = mkdtempSync(path.join(fixture, "non-regular-"));
  const fifo = path.join(directory, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
    expect(() => zipArtifactDirectory(directory, path.join(fixture, "non-regular.zip"))).toThrow(/non-regular/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(path.join(fixture, "non-regular.zip"), { force: true });
  }
});

test("rejects a directory symlink cycle", () => {
  const directory = mkdtempSync(path.join(fixture, "directory-cycle-"));
  const outputZip = path.join(fixture, "directory-cycle.zip");
  try {
    writeFileSync(path.join(directory, "index.mjs"), "export {};");
    symlinkSync(".", path.join(directory, "loop"));
    expect(() => zipArtifactDirectory(directory, outputZip)).toThrow(/cycle/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outputZip, { force: true });
  }
});

test("removes a partially written ZIP after the ZIP command fails", () => {
  const outputZip = path.join(fixture, "failed.zip");
  expect(() => zipArtifactDirectory(artifactDirectory, outputZip, (_args, _cwd) => {
    writeFileSync(outputZip, "partial archive");
    throw new Error("forced zip failure");
  })).toThrow(/Failed to zip artifact directory/);
  expect(existsSync(outputZip)).toBe(false);
});

test("rejects an escaping symlink anywhere in the artifact tree", () => {
  const outside = path.join(fixture, "outside.txt");
  writeFileSync(outside, "not packaged");
  const escapingLink = path.join(artifactDirectory, "unrelated-link");
  symlinkSync(outside, escapingLink);
  try {
    expect(() => synth({
      ...common,
      artifact: { directory: artifactDirectory, entrypoint: "index.mjs" },
    })).toThrow(/symlink|symbolic link|artifact/i);
  } finally {
    rmSync(escapingLink, { force: true });
  }
});

test("rejects a non-directory artifact root and a non-file startup path", () => {
  expect(() => synth({ ...common, artifact: { directory: path.join(fixture, "absent"), entrypoint: "index.mjs" } })).toThrow();
  const directoryEntrypoint = path.join(artifactDirectory, "nested");
  mkdirSync(directoryEntrypoint, { recursive: true });
  expect(() => synth({ ...common, artifact: { directory: artifactDirectory, entrypoint: "nested" } })).toThrow();
});
