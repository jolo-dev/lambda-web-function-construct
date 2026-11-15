import { expect, test } from "bun:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CognitoExampleStack } from "../examples/cognito/stack";

for (const framework of ["hono", "express", "node-http"] as const) {
  test(`${framework} example bundles and provisions isolated Cognito resources`, () => {
    const app = new App();
    const stack = new CognitoExampleStack(app, `Cognito-${framework}`, {
      framework,
      frontendOrigin: "https://frontend.example.com",
      callbackUrls: ["https://frontend.example.com/auth/callback"],
      env: { account: "111111111111", region: "eu-central-1" },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::WebFunction", 1);
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: `webfn-111111111111-eu-central-1-${framework}`,
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: ["https://frontend.example.com/auth/callback"],
    });
    template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
      ServiceConfig: { EnvironmentVariables: {
        FRONTEND_ORIGIN: "https://frontend.example.com",
        COGNITO_USER_POOL_ID: stack.resolve(stack.webFunction.userPool!.userPoolId),
        COGNITO_CLIENT_ID: stack.resolve(stack.webFunction.userPoolClient!.userPoolClientId),
      } },
    });
    expect(stack.webFunction.userPool).toBeDefined();
  });
}

test("example rejects invalid frontend origins before bundling", () => {
  expect(() => new CognitoExampleStack(new App(), "InvalidFrontend", {
    framework: "hono",
    frontendOrigin: "*",
    callbackUrls: ["https://frontend.example.com/auth/callback"],
  })).toThrow(/origin/i);
});
