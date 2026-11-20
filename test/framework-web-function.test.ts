import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Topic } from "aws-cdk-lib/aws-sns";
import { ZodError } from "zod";
import {
  NextJsWebFunction,
  NuxtWebFunction,
  TanStackWebFunction,
  WebFunction,
  WebFunctionDelivery,
} from "../src";
import { NextjsExampleStack } from "../examples/fullstack/nextjs/stack";
import { TanStackStartExampleStack } from "../examples/fullstack/tanstack-start/stack";
import { NuxtExampleStack } from "../examples/fullstack/nuxt/stack";
import { AstroExampleStack } from "../examples/fullstack/astro/stack";

const fixture = mkdtempSync(path.join(tmpdir(), "framework-web-function-"));
process.on("exit", () => {
  rmSync(fixture, { recursive: true, force: true });
});

/** Static asset directories that each framework construct expects under its artifact root. */
const FRAMEWORK_ASSET_DIRECTORY = {
  nextjs: [".next", "static"],
  "tanstack-start": ["dist", "client", "assets"],
  nuxt: [".output", "public", "_nuxt"],
  astro: ["dist", "client", "_astro"],
} as const;

/**
 * Stages a minimal synthesizable artifact root: the `index.js` launcher file plus the
 * framework's hashed static asset directory. Synthesis-only tests never run the launcher.
 */
function artifactDir(
  framework: keyof typeof FRAMEWORK_ASSET_DIRECTORY,
  options: { launcher?: boolean; assets?: boolean } = {},
): string {
  const root = mkdtempSync(path.join(fixture, `artifact-${framework}-`));
  if (options.launcher ?? true) {
    writeFileSync(path.join(root, "index.js"), "console.log('ok');\n");
  }
  if (options.assets ?? true) {
    const assets = path.join(root, ...FRAMEWORK_ASSET_DIRECTORY[framework]);
    mkdirSync(assets, { recursive: true });
    writeFileSync(path.join(assets, "chunk.js"), "export {};\n");
  }
  return root;
}

/** CloudFront DistributionConfig fields needed to assert which URL prefix routes to S3. */
interface DistributionConfigShape {
  readonly Origins: readonly { readonly Id: string; readonly S3OriginConfig?: unknown; readonly CustomOriginConfig?: unknown }[];
  readonly DefaultCacheBehavior: { readonly TargetOriginId: string };
  readonly CacheBehaviors?: readonly { readonly PathPattern: string; readonly TargetOriginId: string }[];
}

/**
 * The single path pattern the delivery routes to an S3 origin — the framework
 * construct's URL prefix plus `*`.
 */
function s3BackedPathPattern(template: Template): string {
  const distributions = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  expect(distributions).toHaveLength(1);
  const config = (distributions[0] as { Properties: { DistributionConfig: DistributionConfigShape } }).Properties
    .DistributionConfig;
  const s3Origins = new Set(config.Origins.filter((origin) => origin.S3OriginConfig !== undefined).map((origin) => origin.Id));
  const s3Backed = config.CacheBehaviors
    ?.filter((behavior) => s3Origins.has(behavior.TargetOriginId))
    .map((behavior) => behavior.PathPattern) ?? [];
  expect(s3Backed).toHaveLength(1);
  return s3Backed[0] ?? "";
}

test("NextJsWebFunction synthesizes function and delivery with framework defaults", () => {
  const app = new App();
  const stack = new Stack(app, "Stack");
  const site = new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "my-site",
  });
  expect(site.webFunction).toBeInstanceOf(WebFunction);
  expect(site.delivery).toBeInstanceOf(WebFunctionDelivery);
  const template = Template.fromStack(stack);
  // The revision environment gains NODE_ENV=production by default.
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { NODE_ENV: "production" } },
  });
  // Fixed auth/endpoint defaults required by the internal delivery.
  template.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
    AuthType: "IamAuth",
    EndpointType: "HomeRegion",
  });
  // TWO BucketDeployments: WebFunction's code deployment AND the delivery's
  // static-assets deployment — do not assert 1.
  template.resourceCountIs("Custom::CDKBucketDeployment", 2);
  // RETAIN is the delivery's default removal policy (the code bucket is always Delete).
  template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
});

test("consumer can override NODE_ENV through environmentVariables", () => {
  const stack = new Stack(new App(), "NodeEnvOverrideStack");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "node-env-override",
    environmentVariables: { NODE_ENV: "test" },
  });
  Template.fromStack(stack).hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { NODE_ENV: "test" } },
  });
});

test("endpoint name defaults to prod", () => {
  const stack = new Stack(new App(), "EndpointNameDefaultStack");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "endpoint-name-default",
  });
  Template.fromStack(stack).hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
    EndpointName: "prod",
  });
});

test("rejects a missing launcher file with a framework-specific message", () => {
  const stack = new Stack(new App(), "MissingLauncherStack");
  expect(() => new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs", { launcher: false }),
    functionName: "missing-launcher",
  })).toThrow(/Next\.js artifact must contain the required launcher file "index\.js"/);
});

test("rejects a missing static asset directory with a framework-specific message", () => {
  const stack = new Stack(new App(), "MissingAssetsStack");
  expect(() => new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs", { assets: false }),
    functionName: "missing-assets",
  })).toThrow(/Next\.js artifact must contain the required static asset directory "\.next\/static"/);
});

test("a permission entry adds one Allow statement for a string action and one ARN", () => {
  const stack = new Stack(new App(), "PermissionStatementStack");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "permission-statement",
    permissions: [{ actions: "s3:GetObject", resources: ["arn:aws:s3:::my-bucket"] }],
  });
  // The role's default policy already carries the logs statement, so the added
  // statement is content-matched — never a bare index. CDK serializes a
  // single-element Action/Resource as a plain string, not an array.
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::my-bucket",
      })]),
    }),
  });
});

test("an action array with multiple ARN resources becomes one Allow statement", () => {
  const stack = new Stack(new App(), "ActionArrayStack");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "action-array",
    permissions: [{
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::other-bucket"],
    }],
  });
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::other-bucket"],
      })]),
    }),
  });
});

test("multiple permission entries land as separate statements on the same role policy", () => {
  const stack = new Stack(new App(), "MultiplePermissionsStack");
  // Resources are the construct's ARN property, passed as a string — including an
  // SNS topic, a service far outside the old dynamodb/s3/sqs conveniences.
  const table = new Table(stack, "Table", {
    partitionKey: { name: "id", type: AttributeType.STRING },
  });
  const topic = new Topic(stack, "Topic");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "multiple-permissions",
    permissions: [
      { actions: "dynamodb:GetItem", resources: [table.tableArn] },
      { actions: "sns:Publish", resources: [topic.topicArn] },
    ],
  });
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        // Single-element Action/Resource serialize as plain strings/objects.
        Match.objectLike({
          Effect: "Allow",
          Action: "dynamodb:GetItem",
          Resource: stack.resolve(table.tableArn),
        }),
        Match.objectLike({
          Effect: "Allow",
          Action: "sns:Publish",
          Resource: stack.resolve(topic.topicArn),
        }),
      ]),
    }),
  });
});

/**
 * Builds the construct with the given invalid permissions and returns the zod
 * issues (path + message) it rejected with, so rejection tests match content.
 */
function permissionRejectionIssues(
  permissions: readonly unknown[],
): { readonly path: string; readonly message: string }[] {
  let caught: unknown;
  try {
    new NextJsWebFunction(new Stack(new App(), "RejectionStack"), "Site", {
      artifactDirectory: artifactDir("nextjs"),
      functionName: "rejection",
      permissions: permissions as never,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  return (caught as ZodError).issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

test("rejects a permission with empty actions", () => {
  const emptyString = permissionRejectionIssues([
    { actions: "", resources: ["arn:aws:s3:::my-bucket"] },
  ]);
  expect(emptyString).toEqual([
    expect.objectContaining({ path: "permissions.0.actions" }),
  ]);
  const emptyArray = permissionRejectionIssues([
    { actions: [], resources: ["arn:aws:s3:::my-bucket"] },
  ]);
  expect(emptyArray).toEqual([
    expect.objectContaining({ path: "permissions.0.actions" }),
  ]);
});

test("rejects a permission with empty resources", () => {
  const emptyArray = permissionRejectionIssues([
    { actions: "s3:GetObject", resources: [] },
  ]);
  expect(emptyArray).toEqual([
    expect.objectContaining({ path: "permissions.0.resources" }),
  ]);
  const emptyString = permissionRejectionIssues([
    { actions: "s3:GetObject", resources: [""] },
  ]);
  expect(emptyString).toEqual([
    expect.objectContaining({ path: "permissions.0.resources.0" }),
  ]);
});

test("TanStackWebFunction maps dist/client/assets to /assets/ and sets NODE_ENV", () => {
  const stack = new Stack(new App(), "TanStackSynthesisStack");
  const site = new TanStackWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("tanstack-start"),
    functionName: "tanstack-synthesis",
  });
  expect(site.webFunction).toBeInstanceOf(WebFunction);
  expect(site.delivery).toBeInstanceOf(WebFunctionDelivery);
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { NODE_ENV: "production" } },
  });
  // The delivery's CloudFront cache behavior is the observable for the framework's
  // URL prefix — /assets/* served from S3, dynamic traffic from the Web Function.
  expect(s3BackedPathPattern(template)).toBe("/assets/*");
});

test("NuxtWebFunction maps .output/public/_nuxt to /_nuxt/ and sets NODE_ENV", () => {
  const stack = new Stack(new App(), "NuxtSynthesisStack");
  const site = new NuxtWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nuxt"),
    functionName: "nuxt-synthesis",
  });
  expect(site.webFunction).toBeInstanceOf(WebFunction);
  expect(site.delivery).toBeInstanceOf(WebFunctionDelivery);
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
    ServiceConfig: { EnvironmentVariables: { NODE_ENV: "production" } },
  });
  expect(s3BackedPathPattern(template)).toBe("/_nuxt/*");
});

// Spec §5.7: the dogfooded TanStack example stack must pass removalPolicy DESTROY
// explicitly — its asset bucket backs the intentionally retained live deployment,
// and dropping the pass-through would silently flip it to the construct's RETAIN
// default, orphaning the bucket on delete.
test("dogfooded TanStack example stack sets asset bucket removal policy to DESTROY", () => {
  const app = new App();
  const stack = new TanStackStartExampleStack(app, "Stack", {
    env: { account: "123456789012", region: "eu-central-1" },
    artifactDirectory: artifactDir("tanstack-start"),
    sessionPassword: "x".repeat(32),
  });
  // The stack contains TWO buckets and WebFunction's code bucket is always
  // DeletionPolicy "Delete", so a single hasResource would pass even if the
  // delivery pass-through were dropped. Assert both — the pattern used in
  // test/web-function-delivery.test.ts:338-350.
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::S3::Bucket", 2);
  expect(
    Object.values(template.findResources("AWS::S3::Bucket"))
      .map((bucket: { DeletionPolicy?: string }) => bucket.DeletionPolicy)
      .sort(),
  ).toEqual(["Delete", "Delete"]);
});

// Spec §5.7: the dogfooded Next.js example stack sets asset bucket removal policy to
// DESTROY — dropping the pass-through would silently flip its asset bucket to the
// construct's RETAIN default, orphaning the bucket on delete.
test("dogfooded Next.js example stack sets asset bucket removal policy to DESTROY", () => {
  const app = new App();
  const stack = new NextjsExampleStack(app, "Stack", {
    env: { account: "123456789012", region: "eu-central-1" },
    artifactDirectory: artifactDir("nextjs"),
  });
  // The stack contains TWO buckets and WebFunction's code bucket is always
  // DeletionPolicy "Delete", so a single hasResource would pass even if the
  // delivery pass-through were dropped. Assert both — the pattern used in
  // test/web-function-delivery.test.ts:338-350.
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::S3::Bucket", 2);
  expect(
    Object.values(template.findResources("AWS::S3::Bucket"))
      .map((bucket: { DeletionPolicy?: string }) => bucket.DeletionPolicy)
      .sort(),
  ).toEqual(["Delete", "Delete"]);
});

// Spec §5.7: the dogfooded Nuxt example stack must pass removalPolicy DESTROY
// explicitly — dropping the pass-through would silently flip its asset bucket
// to the construct's RETAIN default, orphaning the bucket on delete.
test("dogfooded Nuxt example stack sets asset bucket removal policy to DESTROY", () => {
  const app = new App();
  const stack = new NuxtExampleStack(app, "Stack", {
    env: { account: "123456789012", region: "eu-central-1" },
    artifactDirectory: artifactDir("nuxt"),
  });
  // The stack contains TWO buckets and WebFunction's code bucket is always
  // DeletionPolicy "Delete", so a single hasResource would pass even if the
  // delivery pass-through were dropped. Assert both — the pattern used in
  // test/web-function-delivery.test.ts:338-350.
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::S3::Bucket", 2);
  expect(
    Object.values(template.findResources("AWS::S3::Bucket"))
      .map((bucket: { DeletionPolicy?: string }) => bucket.DeletionPolicy)
      .sort(),
  ).toEqual(["Delete", "Delete"]);
});

// Spec §5.7: the Astro example stack passes removalPolicy DESTROY explicitly like
// the other dogfooded stacks — guard it against silently flipping to RETAIN.
test("dogfooded Astro example stack sets asset bucket removal policy to DESTROY", () => {
  const app = new App();
  const stack = new AstroExampleStack(app, "Stack", {
    env: { account: "123456789012", region: "eu-central-1" },
    artifactDirectory: artifactDir("astro"),
  });
  // The stack contains TWO buckets and WebFunction's code bucket is always
  // DeletionPolicy "Delete", so a single hasResource would pass even if the
  // delivery pass-through were dropped. Assert both — the pattern used in
  // test/web-function-delivery.test.ts:338-350.
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::S3::Bucket", 2);
  expect(
    Object.values(template.findResources("AWS::S3::Bucket"))
      .map((bucket: { DeletionPolicy?: string }) => bucket.DeletionPolicy)
      .sort(),
  ).toEqual(["Delete", "Delete"]);
});
