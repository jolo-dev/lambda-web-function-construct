import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { WebFunction, WebFunctionAuthType, WebFunctionEndpointType } from "../src";

const directory = mkdtempSync(path.join(tmpdir(), "cognito-construct-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const entry = path.join(directory, "http.ts");
writeFileSync(entry, "export {};\n");
const defaults = {
  entry,
  functionName: "cognito-test",
  endpointName: "prod",
  endpointType: WebFunctionEndpointType.HOME_REGION,
  authType: WebFunctionAuthType.APPLICATION_MANAGED,
};
const cognito = {
  domainPrefix: "web-function-test-login",
  callbackUrls: ["http://localhost:5173/auth/callback"],
  logoutUrls: ["http://localhost:5173/"],
};

function create(overrides: Record<string, unknown> = {}) {
  const stack = new Stack(new App(), "CognitoTest", {
    env: { account: "111111111111", region: "eu-central-1" },
  });
  const fn: WebFunction = Reflect.construct(WebFunction, [stack, "Api", { ...defaults, ...overrides }]);
  return { fn, template: Template.fromStack(stack) };
}

test("Cognito is opt-in and leaves existing environment variables unchanged", () => {
  const { fn, template } = create({ environmentVariables: { CUSTOM: "value" } });
  template.resourceCountIs("AWS::Cognito::UserPool", 0);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { CUSTOM: "value" } },
  });
  expect(Reflect.get(fn, "userPool")).toBeUndefined();
  expect(Reflect.get(fn, "userPoolClient")).toBeUndefined();
  expect(Reflect.get(fn, "userPoolDomain")).toBeUndefined();
});

test("opt-in creates a retained pool, public code client, managed login and verifier configuration", () => {
  const { fn, template } = create({ cognito, environmentVariables: { CUSTOM: "value" } });
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  template.hasResource("AWS::Cognito::UserPool", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
    },
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthScopes: ["openid", "profile", "email"],
    CallbackURLs: cognito.callbackUrls,
    LogoutURLs: cognito.logoutUrls,
    EnableTokenRevocation: true,
    RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 10 },
    AccessTokenValidity: 10,
    IdTokenValidity: 10,
    TokenValidityUnits: Match.objectLike({ AccessToken: "minutes", IdToken: "minutes" }),
  });
  const client = Object.values(template.findResources("AWS::Cognito::UserPoolClient"))[0]!;
  expect(client.Properties.ExplicitAuthFlows).not.toContain("ALLOW_REFRESH_TOKEN_AUTH");
  template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
    Domain: cognito.domainPrefix,
    ManagedLoginVersion: 2,
  });
  template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
    UseCognitoProvidedValues: true,
  });
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: {
      CUSTOM: "value",
      COGNITO_USER_POOL_ID: Match.anyValue(),
      COGNITO_CLIENT_ID: Match.anyValue(),
    } },
  });
  expect(Reflect.get(fn, "userPool")).toBeDefined();
  expect(Reflect.get(fn, "userPoolClient")).toBeDefined();
  expect(Reflect.get(fn, "userPoolDomain")).toBeDefined();
  const outputs = JSON.stringify(template.toJSON().Outputs);
  expect(outputs).toContain("CognitoUserPoolId");
  expect(outputs).toContain("CognitoClientId");
  expect(outputs).toContain("CognitoLoginDomain");
  const issuer = Object.entries(template.toJSON().Outputs)
    .find(([key]) => key.includes("CognitoIssuer"))?.[1] as { Value: unknown };
  expect(issuer.Value).toEqual({ "Fn::Join": ["", [
    "https://cognito-idp.eu-central-1.", { Ref: "AWS::URLSuffix" }, "/",
    { Ref: Object.keys(template.findResources("AWS::Cognito::UserPool"))[0] },
  ]] });
});

test("logout URLs default to callback URLs when omitted", () => {
  const { template } = create({ cognito: { domainPrefix: cognito.domainPrefix, callbackUrls: cognito.callbackUrls } });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", { LogoutURLs: cognito.callbackUrls });
});

test.each([
  { authType: WebFunctionAuthType.IAM_AUTH, cognito },
  { cognito: { ...cognito, callbackUrls: [] } },
  { cognito: { ...cognito, domainPrefix: "Invalid_Prefix" } },
  { cognito: { ...cognito, callbackUrls: ["http://example.com/callback"] } },
  { cognito: { ...cognito, callbackUrls: ["https://example.com/callback#fragment"] } },
  { cognito: { ...cognito, logoutUrls: ["javascript:alert(1)"] } },
  { cognito, environmentVariables: { COGNITO_CLIENT_ID: "different-client" } },
  { cognito, environmentVariables: { COGNITO_USER_POOL_ID: "different-pool" } },
])("rejects invalid Cognito configuration before bundling: %j", (overrides) => {
  const stack = new Stack(new App(), "InvalidCognito");
  expect(() => Reflect.construct(WebFunction, [stack, "Api", {
    ...defaults, ...overrides, entry: "does-not-exist.ts",
  }])).toThrow(/cognito|Cognito|COGNITO/);
});

test("accepts HTTPS and IPv4/IPv6 loopback callback URLs", () => {
  const urls = ["https://app.example.com/callback", "http://127.0.0.1:5173/callback", "http://[::1]:5173/callback"];
  const { template } = create({ cognito: { ...cognito, callbackUrls: urls } });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", { CallbackURLs: urls });
});
