import path from "node:path";
import { App } from "aws-cdk-lib";
import { readSessionPassword, SESSION_PASSWORD_ENV } from "./shared/session-secret";
import { AstroExampleStack } from "./astro/stack";
import { NextjsExampleStack } from "./nextjs/stack";
import { NuxtExampleStack } from "./nuxt/stack";
import { TanStackStartExampleStack } from "./tanstack-start/stack";

/**
 * Deployment entry for the four fullstack examples (the astro example needs a staged
 * linux-arm64 artifact first; see the FullstackAstro note below). Artifacts must be built
 * first (build-native.sh per example, or build-arm64.sh for a container arm64 build); synthesis
 * never runs a framework build.
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
// The astro artifact is currently native-darwin-arm64 only: the shared artifact() helper
// resolves linux-arm64, which is not built in this change. Stage one with
// `bash examples/fullstack/shared/build-arm64.sh examples/fullstack/astro -- node build-artifact.mjs`
// before synthesizing a real FullstackAstro deployment.
new AstroExampleStack(app, "FullstackAstro", {
  artifactDirectory: path.join(root, "examples", "fullstack", "artifacts", "astro", "native-darwin-arm64"),
  env,
});
new NuxtExampleStack(app, "FullstackNuxt", { artifactDirectory: artifact("nuxt"), env });
new TanStackStartExampleStack(app, "FullstackTanStackStart", {
  artifactDirectory: artifact("tanstack-start"),
  sessionPassword: readSessionPassword(process.env[SESSION_PASSWORD_ENV]),
  env,
});

app.synth();
