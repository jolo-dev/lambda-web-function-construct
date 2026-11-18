import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { WebFunction, WebFunctionAuthType, WebFunctionEndpointType } from "../src";
import { zipArtifactDirectory } from "../src/web-function-artifact";

const fixture = mkdtempSync(path.join(tmpdir(), "web-function-artifact-"));
const artifactDirectory = path.join(fixture, "artifact");
mkdirSync(artifactDirectory);
writeFileSync(path.join(artifactDirectory, "index.mjs"), "export {};");
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
  mkdirSync(path.join(artifactDirectory, "nested"), { recursive: true });
  writeFileSync(path.join(artifactDirectory, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(artifactDirectory, "nested", "package.json"), JSON.stringify({ name: "nested-runtime" }));
  writeFileSync(path.join(artifactDirectory, "nested", "runtime.mjs"), "export const answer = 42;");
  symlinkSync(path.join("nested", "runtime.mjs"), path.join(artifactDirectory, "linked-runtime.mjs"));
  symlinkSync("nested", path.join(artifactDirectory, "linked-directory"));
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

test("stages internal file and directory symlinks as regular content", () => {
  const outputZip = path.join(fixture, "staged.zip");
  zipArtifactDirectory(artifactDirectory, outputZip, (args, cwd) => {
    expect(realpathSync(cwd)).not.toBe(realpathSync(artifactDirectory));
    expect(lstatSync(path.join(cwd, "linked-runtime.mjs")).isFile()).toBe(true);
    expect(lstatSync(path.join(cwd, "linked-directory")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(cwd, "linked-runtime.mjs"), "utf8")).toContain("answer = 42");
    execFileSync("zip", args, { cwd });
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
