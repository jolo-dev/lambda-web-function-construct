import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionDelivery,
  WebFunctionEndpointType,
} from "../src";

const fixture = mkdtempSync(path.join(tmpdir(), "web-function-delivery-"));
process.on("exit", () => rmSync(fixture, { recursive: true, force: true }));

const entry = path.join(fixture, "http.ts");
writeFileSync(entry, "export const handler = (): Response => new Response('ok');\n");

const staticDirectory = path.join(fixture, "static");
mkdirSync(staticDirectory, { recursive: true });
writeFileSync(path.join(staticDirectory, "chunk.js"), "export {};");

const secondStaticDirectory = path.join(fixture, "public-assets");
mkdirSync(secondStaticDirectory, { recursive: true });
writeFileSync(path.join(secondStaticDirectory, "logo.svg"), "<svg/>");

const webFunctionProps = {
  entry,
  functionName: "delivery-test",
  authType: WebFunctionAuthType.IAM_AUTH,
  endpointType: WebFunctionEndpointType.HOME_REGION,
  endpointName: "prod",
};

function logicalIdWhere(
  template: Template,
  type: string,
  predicate: (resource: { DeletionPolicy?: string; Properties: any }) => boolean,
): string {
  const matches = Object.entries(template.findResources(type))
    .filter(([, resource]) => predicate(resource as never))
    .map(([logicalId]) => logicalId);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function iamWebFunction(stack: Stack, id = "App"): WebFunction {
  return new WebFunction(stack, id, webFunctionProps);
}

test("rejects a Web Function that uses ApplicationManaged authentication", () => {
  const stack = new Stack(new App(), "ApplicationManagedStack");
  const webFunction = new WebFunction(stack, "App", {
    ...webFunctionProps,
    authType: WebFunctionAuthType.APPLICATION_MANAGED,
  });

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow(/IamAuth/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test("rejects a MultiRegion Web Function endpoint", () => {
  const stack = new Stack(new App(), "MultiRegionStack");
  const webFunction = new WebFunction(stack, "App", {
    ...webFunctionProps,
    endpointType: WebFunctionEndpointType.MULTI_REGION,
    regions: ["us-east-1", "us-west-2"],
  });

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow(/HomeRegion/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test("rejects a Web Function from another stack", () => {
  const app = new App();
  const webFunction = iamWebFunction(new Stack(app, "FunctionStack"));
  const deliveryStack = new Stack(app, "DeliveryStack");

  expect(() => new WebFunctionDelivery(deliveryStack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow(/same stack/);
  expect(Template.fromStack(deliveryStack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test("rejects a missing static asset directory", () => {
  const stack = new Stack(new App(), "MissingDirectoryStack");
  const webFunction = iamWebFunction(stack);

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: path.join(fixture, "absent"), urlPrefix: "/_next/static/" }],
  })).toThrow(/must be an existing directory/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test.each([
  ["the root prefix", "/"],
  ["a wildcard prefix", "/_next/*"],
  ["a traversal segment", "/_next/../secret/"],
  ["a relative prefix", "_next/static/"],
  ["an empty segment", "/_next//static/"],
  ["an encoded traversal segment", "/_next/%2e%2e/"],
])("rejects %s before constructing a distribution", (_label, urlPrefix) => {
  const stack = new Stack(new App(), "InvalidPrefixStack");
  const webFunction = iamWebFunction(stack);

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix }],
  })).toThrow(/URL prefix/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test("rejects an empty static asset mapping list before constructing a distribution", () => {
  const stack = new Stack(new App(), "EmptyMappingsStack");
  const webFunction = iamWebFunction(stack);

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [],
  })).toThrow(/expected array to have >=1 items/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test.each([
  ["identical prefixes", "/_next/static/", "/_next/static/"],
  ["a prefix and its descendant", "/_next/", "/_next/static/"],
  ["a descendant before its parent", "/_next/static", "/_next/"],
])("rejects overlapping prefixes with %s", (_label, first, second) => {
  const stack = new Stack(new App(), "OverlappingPrefixStack");
  const webFunction = iamWebFunction(stack);

  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [
      { directory: staticDirectory, urlPrefix: first },
      { directory: secondStaticDirectory, urlPrefix: second },
    ],
  })).toThrow(/overlap/);
  expect(Template.fromStack(stack).findResources("AWS::CloudFront::Distribution")).toEqual({});
});

test("rejects a second delivery attachment to the same Web Function", () => {
  const stack = new Stack(new App(), "SecondDeliveryStack");
  const webFunction = iamWebFunction(stack);
  new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  });

  expect(() => new WebFunctionDelivery(stack, "SecondDelivery", {
    webFunction,
    staticAssets: [{ directory: secondStaticDirectory, urlPrefix: "/assets/" }],
  })).toThrow(/already has a delivery/);
  Template.fromStack(stack).resourceCountIs("AWS::CloudFront::Distribution", 1);
});

test("releases no delivery claim when a later construction step fails", () => {
  const stack = new Stack(new App(), "FailedAttachStack");
  const webFunction = iamWebFunction(stack);
  // The resource policy is the last construction step and the only reader of functionArn.
  const functionArn = webFunction.functionArn;
  let failNextRead = true;
  Object.defineProperty(webFunction, "functionArn", {
    configurable: true,
    get: () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("injected resource policy failure");
      }
      return functionArn;
    },
  });

  expect(() => new WebFunctionDelivery(stack, "FailedDelivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow("injected resource policy failure");

  const retried = new WebFunctionDelivery(stack, "RetriedDelivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  });
  expect(retried.url).toMatch(/^https:\/\//);
});

test("synthesizes a private CloudFront delivery for one IAM HomeRegion static mapping", () => {
  const app = new App();
  const stack = new Stack(app, "DeliveryStack");
  const webFunction = iamWebFunction(stack);
  const delivery = new WebFunctionDelivery(stack, "Delivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  });
  const template = Template.fromStack(stack);

  expect(delivery.url).toMatch(/^https:\/\//);
  expect(delivery.distribution).toBeDefined();
  expect(delivery.assetBucket).toBeDefined();

  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
  template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
    OriginAccessControlConfig: {
      OriginAccessControlOriginType: "lambda",
      SigningBehavior: "always-amz-auth",
      SigningProtocol: "sigv4",
    },
  });
  template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
    OriginAccessControlConfig: {
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    },
  });
  const lambdaOacId = logicalIdWhere(template, "AWS::CloudFront::OriginAccessControl", (resource) =>
    resource.Properties.OriginAccessControlConfig.OriginAccessControlOriginType === "lambda");
  const s3OacId = logicalIdWhere(template, "AWS::CloudFront::OriginAccessControl", (resource) =>
    resource.Properties.OriginAccessControlConfig.OriginAccessControlOriginType === "s3");

  // The Web Function code bucket is also an S3 bucket; the asset bucket is the one retained by default.
  template.resourceCountIs("AWS::S3::Bucket", 2);
  const assetBucketId = logicalIdWhere(template, "AWS::S3::Bucket", (resource) => resource.DeletionPolicy === "Retain");
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    Bucket: { Ref: assetBucketId },
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ]),
    },
  });

  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: {
        AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
        ViewerProtocolPolicy: "https-only",
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      },
      CacheBehaviors: [
        Match.objectLike({
          PathPattern: "/_next/static/*",
          AllowedMethods: ["GET", "HEAD"],
          ViewerProtocolPolicy: "https-only",
        }),
      ],
      Origins: Match.arrayWith([
        Match.objectLike({
          OriginAccessControlId: { "Fn::GetAtt": [lambdaOacId, "Id"] },
          CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: "https-only" }),
        }),
        Match.objectLike({
          OriginAccessControlId: { "Fn::GetAtt": [s3OacId, "Id"] },
          S3OriginConfig: Match.anyValue(),
        }),
      ]),
    },
  });

  template.resourceCountIs("AWS::Lambda::ResourcePolicy", 1);
  const endpointId = logicalIdWhere(template, "AWS::Lambda::WebFunctionEndpoint", () => true);
  const functionId = logicalIdWhere(template, "AWS::Lambda::WebFunction", () => true);
  const distributionId = logicalIdWhere(template, "AWS::CloudFront::Distribution", () => true);
  template.hasResourceProperties("AWS::Lambda::ResourcePolicy", {
    ResourceArn: { Ref: functionId },
    PolicyDocument: {
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "lambda:InvokeWebFunctionEndpoint",
          Resource: { "Fn::GetAtt": [endpointId, "EndpointArn"] },
          Condition: {
            StringEquals: {
              "aws:SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    ":cloudfront::",
                    { Ref: "AWS::AccountId" },
                    ":distribution/",
                    { Ref: distributionId },
                  ],
                ],
              },
            },
          },
        },
      ],
    },
  });
  template.resourceCountIs("AWS::Lambda::Permission", 0);
});

test("creates no CloudFront browser delivery resources for a WebFunction-only stack", () => {
  const stack = new Stack(new App(), "WebFunctionOnlyStack");
  iamWebFunction(stack);
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::CloudFront::Distribution", 0);
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
  template.resourceCountIs("AWS::Lambda::ResourcePolicy", 0);
});

test("retains the asset bucket by default and destroys its objects only when requested", () => {
  const retained = new Stack(new App(), "RetainedAssetsStack");
  new WebFunctionDelivery(retained, "Delivery", {
    webFunction: iamWebFunction(retained),
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  });
  const retainedTemplate = Template.fromStack(retained);
  retainedTemplate.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  expect(Object.values(retainedTemplate.findResources("AWS::S3::Bucket")).map((bucket) => bucket.DeletionPolicy).sort())
    .toEqual(["Delete", "Retain"]);

  const disposable = new Stack(new App(), "DisposableAssetsStack");
  new WebFunctionDelivery(disposable, "Delivery", {
    webFunction: iamWebFunction(disposable),
    removalPolicy: RemovalPolicy.DESTROY,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  });
  const disposableTemplate = Template.fromStack(disposable);
  disposableTemplate.resourceCountIs("Custom::S3AutoDeleteObjects", 2);
  expect(Object.values(disposableTemplate.findResources("AWS::S3::Bucket")).map((bucket) => bucket.DeletionPolicy))
    .toEqual(["Delete", "Delete"]);
});

test("rejects an asset bucket removal policy other than RETAIN or DESTROY", () => {
  const stack = new Stack(new App(), "SnapshotPolicyStack");
  expect(() => new WebFunctionDelivery(stack, "Delivery", {
    webFunction: iamWebFunction(stack),
    removalPolicy: RemovalPolicy.SNAPSHOT,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow(/RETAIN or DESTROY/);
  Template.fromStack(stack).resourceCountIs("AWS::CloudFront::Distribution", 0);
});

test("normalizes a static prefix without a trailing slash and shares one private origin across mappings", () => {
  const stack = new Stack(new App(), "MultipleMappingsStack");
  new WebFunctionDelivery(stack, "Delivery", {
    webFunction: iamWebFunction(stack),
    staticAssets: [
      { directory: staticDirectory, urlPrefix: "/_next/static" },
      { directory: secondStaticDirectory, urlPrefix: "/assets/" },
    ],
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      CacheBehaviors: [
        Match.objectLike({ PathPattern: "/_next/static/*", AllowedMethods: ["GET", "HEAD"] }),
        Match.objectLike({ PathPattern: "/assets/*", AllowedMethods: ["GET", "HEAD"] }),
      ],
    },
  });
  template.resourceCountIs("AWS::Lambda::ResourcePolicy", 1);
  template.resourceCountIs("AWS::Lambda::Permission", 0);
});
