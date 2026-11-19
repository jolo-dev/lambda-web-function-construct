import path from "node:path";
import { App } from "aws-cdk-lib";
import { readSessionPassword, SESSION_PASSWORD_ENV } from "./shared/session-secret";
import { NextjsExampleStack } from "./nextjs/stack";
import { NuxtExampleStack } from "./nuxt/stack";
import { TanStackStartExampleStack } from "./tanstack-start/stack";

/**
 * Deployment entry for the three fullstack examples. Artifacts must be built first with
 * `bash examples/fullstack/shared/build-arm64-artifacts.sh`; synthesis never runs a framework build.
 * Region/account come from CDK_DEFAULT_* (set by the CLI from the selected profile/region).
 */
const app = new App();
const root = path.resolve(import.meta.dirname, "..", "..");
const artifact = (framework: string) => path.join(root, "examples", "fullstack", "artifacts", framework, "linux-arm64");
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new NextjsExampleStack(app, "FullstackNextjs", { artifactDirectory: artifact("nextjs"), env });
new NuxtExampleStack(app, "FullstackNuxt", { artifactDirectory: artifact("nuxt"), env });
new TanStackStartExampleStack(app, "FullstackTanStackStart", {
  artifactDirectory: artifact("tanstack-start"),
  sessionPassword: readSessionPassword(process.env[SESSION_PASSWORD_ENV]),
  env,
});

app.synth();
