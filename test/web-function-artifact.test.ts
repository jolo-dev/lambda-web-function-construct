import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { WebFunction, WebFunctionAuthType, WebFunctionEndpointType } from "../src";

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
  const stack = new Stack(new App(), `Artifact${Math.random().toString(36).slice(2)}`);
  const webFunction = new WebFunction(stack, "App", props as never);
  return { webFunction, template: Template.fromStack(stack) };
}

test("packages a prebuilt artifact and exposes endpoint properties", () => {
  const { webFunction, template } = synth({
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

test("rejects a non-directory artifact root and a non-file startup path", () => {
  expect(() => synth({ ...common, artifact: { directory: path.join(fixture, "absent"), entrypoint: "index.mjs" } })).toThrow();
  const directoryEntrypoint = path.join(artifactDirectory, "nested");
  mkdirSync(directoryEntrypoint);
  expect(() => synth({ ...common, artifact: { directory: artifactDirectory, entrypoint: "nested" } })).toThrow();
});
