import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionEndpointType,
} from "../src";

const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "web-function-test-"));
process.on("exit", () => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

const entry = path.join(fixtureDirectory, "http.ts");
writeFileSync(
  entry,
  "export const handler = (): Response => new Response('ok');\n",
);

test("creates a web function endpoint after its first revision", () => {
  const app = new App();
  const stack = new Stack(app, "WebFunctionTestStack");

  new WebFunction(stack, "WebFunction", {
    entry,
    functionName: "test-web-function",
    authType: WebFunctionAuthType.APPLICATION_MANAGED,
    endpointType: WebFunctionEndpointType.HOME_REGION,
    endpointName: "test",
  });

  const assembly = app.synth();
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::Lambda::WebFunction", 1);
  template.resourceCountIs("AWS::Lambda::WebFunctionRevision", 1);
  template.resourceCountIs("AWS::Lambda::WebFunctionEndpoint", 1);

  const endpoint = Object.values(
    template.findResources("AWS::Lambda::WebFunctionEndpoint"),
  )[0];
  const revisionLogicalId = Object.keys(
    template.findResources("AWS::Lambda::WebFunctionRevision"),
  )[0];
  const endpointDependencies = Array.isArray(endpoint?.DependsOn)
    ? endpoint.DependsOn
    : [endpoint?.DependsOn];

  expect(endpointDependencies).toContain(revisionLogicalId);
  expect(assembly.directory).toBeTruthy();
});
