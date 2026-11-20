import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
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

test("permissions.dynamodb grants read/write data access", () => {
  const stack = new Stack(new App(), "DynamodbPermissionsStack");
  const table = new Table(stack, "Table", {
    partitionKey: { name: "id", type: AttributeType.STRING },
  });
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "dynamodb-grants",
    permissions: { dynamodb: [table] },
  });
  // The role's default policy already carries the logs statement, so grants never
  // sit at a fixed index. Match.arrayWith is an ordered-subsequence matcher over
  // the pinned aws-cdk-lib grant emission (Query, GetItem, ..., PutItem).
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"]),
      })]),
    }),
  });
});

test("permissions.s3 grants read/write object access", () => {
  const stack = new Stack(new App(), "S3PermissionsStack");
  const bucket = new Bucket(stack, "Bucket");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "s3-grants",
    permissions: { s3: [bucket] },
  });
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        // aws-cdk-lib grants s3:PutObject (no wildcard) since ACL-modification
        // actions were removed from grantReadWrite.
        Action: Match.arrayWith(["s3:GetObject*", "s3:DeleteObject*", "s3:PutObject"]),
      })]),
    }),
  });
});

test("permissions.sqs grants send access", () => {
  const stack = new Stack(new App(), "SqsPermissionsStack");
  const queue = new Queue(stack, "Queue");
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "sqs-grants",
    permissions: { sqs: [queue] },
  });
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        // grantSendMessages emits SendMessage plus the queue-lookup actions;
        // SendMessageBatch is not part of this grant.
        Action: Match.arrayWith(["sqs:SendMessage", "sqs:GetQueueAttributes"]),
      })]),
    }),
  });
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

test("combined permissions grant the union on the execution role policy", () => {
  const stack = new Stack(new App(), "CombinedPermissionsStack");
  const tables = [0, 1].map((i) => new Table(stack, `Table${i}`, {
    partitionKey: { name: "id", type: AttributeType.STRING },
  }));
  const buckets = [0, 1].map((i) => new Bucket(stack, `Bucket${i}`));
  const queues = [0, 1].map((i) => new Queue(stack, `Queue${i}`));
  new NextJsWebFunction(stack, "Site", {
    artifactDirectory: artifactDir("nextjs"),
    functionName: "combined-grants",
    permissions: { dynamodb: tables, s3: buckets, sqs: queues },
  });
  // All three families land in the same PolicyDocument (the execution role's
  // default policy). arrayWith is an ordered-subsequence matcher, so the
  // statement patterns follow the document order the grants are added in:
  // dynamodb, then s3, then sqs (logs first, bucket deployments own other policies).
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"]),
        }),
        Match.objectLike({
          Action: Match.arrayWith(["s3:GetObject*", "s3:DeleteObject*", "s3:PutObject"]),
        }),
        Match.objectLike({
          Action: Match.arrayWith(["sqs:SendMessage", "sqs:GetQueueAttributes"]),
        }),
      ]),
    }),
  });
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
