import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionEndpointType,
} from "../src";
import { BunHttpContainerFunctionStack } from "../examples/bun-http/stack";
import { ExpressWebFunctionStack } from "../examples/express/stack";
import { H3WebFunctionStack } from "../examples/h3/stack";
import { HonoWebFunctionStack } from "../examples/hono/stack";
import { LambdaApiGwStack } from "../examples/lambda-apigw/stack";
import { NodeHttpWebFunctionStack } from "../examples/node-http/stack";

const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "web-function-test-"));
process.on("exit", () => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

const entry = path.join(fixtureDirectory, "http.ts");
writeFileSync(
  entry,
  "export const handler = (): Response => new Response('ok');\n",
);

test.each([
  [WebFunctionAuthType.IAM_AUTH, "IamAuth"],
  [WebFunctionAuthType.APPLICATION_MANAGED, "ApplicationManaged"],
])("authentication option %s is a typed value", (option, value) => {
  expect(option).toBeInstanceOf(WebFunctionAuthType);
  expect(option.value).toBe(value);
});

test.each([
  [WebFunctionEndpointType.HOME_REGION, "HomeRegion"],
  [WebFunctionEndpointType.MULTI_REGION, "MultiRegion"],
  [WebFunctionEndpointType.PER_REGION, "PerRegion"],
])("endpoint option %s is a typed value", (option, value) => {
  expect(option).toBeInstanceOf(WebFunctionEndpointType);
  expect(option.value).toBe(value);
});

test("Zod rejects unsupported values even if JavaScript bypasses private constructors", () => {
  expect(() => Reflect.construct(WebFunctionAuthType, ["invalid"])).toThrow(
    /Invalid option/,
  );
  expect(() => Reflect.construct(WebFunctionEndpointType, ["invalid"])).toThrow(
    /Invalid option/,
  );
});

test("rejects plain strings instead of typed options before bundling", () => {
  const stack = new Stack(new App(), "InvalidOptionsStack");
  expect(() => Reflect.construct(WebFunction, [stack, "Invalid", {
    entry: "nonexistent.ts",
    functionName: "invalid-options",
    authType: "ApplicationManaged",
    endpointType: "HomeRegion",
    endpointName: "test",
  }])).toThrow(/instance of WebFunctionAuthType/);
});

test("creates a web function endpoint after its first revision", () => {
  const app = new App();
  const stack = new Stack(app, "WebFunctionTestStack");

  const webFn = new WebFunction(stack, "WebFunction", {
    entry,
    functionName: "test-web-function",
    authType: WebFunctionAuthType.APPLICATION_MANAGED,
    endpointType: WebFunctionEndpointType.HOME_REGION,
    endpointName: "test",
    maxConcurrencyPerEnvironment: 64,
    timeoutSeconds: 30,
    environmentVariables: { SERVER_FRAMEWORK: "node-http" },
    loggingConfig: {
      applicationLogLevel: "INFO",
      systemLogLevel: "DEBUG",
    },
  });

  const assembly = app.synth();
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::Lambda::WebFunction", 1);
  template.resourceCountIs("AWS::Lambda::WebFunctionRevision", 1);
  template.resourceCountIs("AWS::Lambda::WebFunctionEndpoint", 1);
  template.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
    AuthType: "ApplicationManaged",
    EndpointType: "HomeRegion",
  });
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: {
      EnvironmentVariables: { SERVER_FRAMEWORK: "node-http" },
      MaxConcurrencyPerEnvironment: 64,
      TimeoutSeconds: 30,
      TelemetryConfig: {
        LoggingConfig: {
          ApplicationLogLevel: "INFO",
          SystemLogLevel: "DEBUG",
        },
      },
    },
  });

  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: Match.arrayWith([Match.objectLike({
          "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(":log-group:/aws/lambda/web/test-web-function")])]),
        })]),
      })]),
    },
  });

  expect(webFn.functionArn).toBeTruthy();
  expect(webFn.endpointDomainName).toBeTruthy();
  expect(webFn.revisionId).toBeTruthy();

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
  const loggingPolicyId = Object.entries(template.findResources("AWS::IAM::Policy"))
    .find(([, resource]) => JSON.stringify(resource).includes("logs:PutLogEvents"))?.[0];
  const revision = template.findResources("AWS::Lambda::WebFunctionRevision")[revisionLogicalId!];
  expect(revision.DependsOn).toContain(loggingPolicyId);
  expect(assembly.directory).toBeTruthy();
});

test("synthesizes all six benchmark example stacks cleanly", () => {
  const app = new App();
  const nodeStack = new NodeHttpWebFunctionStack(app, "NodeHttpExampleStack");
  const expressStack = new ExpressWebFunctionStack(app, "ExpressExampleStack");
  const honoStack = new HonoWebFunctionStack(app, "HonoExampleStack");
  const h3Stack = new H3WebFunctionStack(app, "H3ExampleStack");
  const apigwStack = new LambdaApiGwStack(app, "LambdaApiGwExampleStack");
  const bunStack = new BunHttpContainerFunctionStack(app, "BunHttpExampleStack");

  for (const wfStack of [nodeStack, expressStack, honoStack, h3Stack]) {
    const tpl = Template.fromStack(wfStack);
    tpl.resourceCountIs("AWS::Lambda::WebFunction", 1);
    tpl.resourceCountIs("AWS::Lambda::WebFunctionRevision", 1);
    tpl.resourceCountIs("AWS::Lambda::WebFunctionEndpoint", 1);
  }

  const apigwTpl = Template.fromStack(apigwStack);
  apigwTpl.resourceCountIs("AWS::Lambda::Function", 1);
  apigwTpl.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  apigwTpl.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);

  const bunTpl = Template.fromStack(bunStack);
  bunTpl.resourceCountIs("AWS::Lambda::Function", 1);
  bunTpl.resourceCountIs("AWS::Lambda::Url", 1);
  bunTpl.hasResourceProperties("AWS::Lambda::Function", {
    PackageType: "Image",
    Architectures: ["arm64"],
    MemorySize: 2048,
  });
});
