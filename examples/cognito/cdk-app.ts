import { App } from "aws-cdk-lib";
import { CognitoExampleStack } from "./stack";

const app = new App();
const frontendOrigin: string = app.node.tryGetContext("frontendOrigin") ?? "http://localhost:5173";
const callbackUrl: string = app.node.tryGetContext("callbackUrl") ?? `${frontendOrigin}/auth/callback`;
const logoutUrl: string = app.node.tryGetContext("logoutUrl") ?? `${frontendOrigin}/`;
const domainPrefix: string | undefined = app.node.tryGetContext("domainPrefix");

for (const framework of ["hono", "express", "node-http"] as const) {
  new CognitoExampleStack(app, `Cognito-${framework}`, {
    framework,
    frontendOrigin,
    callbackUrls: [callbackUrl],
    logoutUrls: [logoutUrl],
    domainPrefix: domainPrefix ? `${domainPrefix}-${framework}` : undefined,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    },
  });
}
app.synth();
