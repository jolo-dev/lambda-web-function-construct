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
  ["a single-character wildcard", "/_next/static?/"],
  ["a traversal segment", "/_next/../secret/"],
  ["a relative prefix", "_next/static/"],
  ["an empty segment", "/_next//static/"],
  ["an encoded traversal segment", "/_next/%2e%2e/"],
  ["a non-ASCII character", "/_next/statíc/"],
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
  let functionArnReads = 0;
  Object.defineProperty(webFunction, "functionArn", {
    configurable: true,
    get: () => {
      functionArnReads += 1;
      if (functionArnReads === 1) {
        throw new Error("injected resource policy failure");
      }
      return functionArn;
    },
  });

  expect(() => new WebFunctionDelivery(stack, "FailedDelivery", {
    webFunction,
    staticAssets: [{ directory: staticDirectory, urlPrefix: "/_next/static/" }],
  })).toThrow("injected resource policy failure");
  expect(functionArnReads).toBe(1);
  Template.fromStack(stack).resourceCountIs("AWS::Lambda::ResourcePolicy", 0);

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
  retainedTemplate.hasResourceProperties("Custom::CDKBucketDeployment", {
    DestinationBucketKeyPrefix: "_next/static",
    RetainOnDelete: true,
  });
  disposableTemplate.hasResourceProperties("Custom::CDKBucketDeployment", {
    DestinationBucketKeyPrefix: "_next/static",
    RetainOnDelete: false,
  });
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
  const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  const origins = distribution!.Properties.DistributionConfig.Origins;
  expect(origins).toHaveLength(2);
  expect(origins.filter((origin: { CustomOriginConfig?: unknown }) => origin.CustomOriginConfig)).toHaveLength(1);
  expect(origins.filter((origin: { S3OriginConfig?: unknown }) => origin.S3OriginConfig)).toHaveLength(1);
  template.resourceCountIs("AWS::Lambda::ResourcePolicy", 1);
  template.resourceCountIs("AWS::Lambda::Permission", 0);
});

type CloudFormationTemplate = {
  Resources: Record<string, { DependsOn?: string | string[]; Properties?: unknown; Type: string }>;
};

/** Edges from each resource to the resources it names with DependsOn, Ref, or Fn::GetAtt. */
function dependencyGraph(template: CloudFormationTemplate): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const targets = new Set<string>([resource.DependsOn ?? []].flat());
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value !== null && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          if (key === "Ref" && typeof nested === "string") targets.add(nested);
          else if (key === "Fn::GetAtt" && Array.isArray(nested)) targets.add(String(nested[0]));
          else visit(nested);
        }
      }
    };
    visit(resource.Properties);
    graph.set(logicalId, new Set([...targets].filter((target) => target in template.Resources)));
  }
  return graph;
}

function reachableFrom(graph: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    for (const next of graph.get(pending.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}

/** Returns one dependency cycle as a list of logical IDs, or undefined when the graph is acyclic. */
function findCycle(graph: Map<string, Set<string>>): string[] | undefined {
  const finished = new Set<string>();
  const onPath: string[] = [];
  const visit = (node: string): string[] | undefined => {
    const position = onPath.indexOf(node);
    if (position !== -1) return [...onPath.slice(position), node];
    if (finished.has(node)) return undefined;
    onPath.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    onPath.pop();
    finished.add(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Runs a synthesized CloudFront Function's source exactly as deployed, not a reimplementation. */
function deployedViewerRequestHandler(template: Template): (event: unknown) => any {
  const [functionResource] = Object.values(template.findResources("AWS::CloudFront::Function"));
  const code = (functionResource as { Properties: { FunctionCode: string } }).Properties.FunctionCode;
  return new Function(`${code}\nreturn handler;`)();
}

function staticUploads(template: Template, urlKeyPrefix: string): string[] {
  return Object.entries(template.findResources("Custom::CDKBucketDeployment"))
    .filter(([, resource]) => resource.Properties.DestinationBucketKeyPrefix === urlKeyPrefix)
    .map(([logicalId]) => logicalId);
}

function deliveryStack(name: string, directory = staticDirectory): Stack {
  const stack = new Stack(new App(), name);
  new WebFunctionDelivery(stack, "Delivery", {
    webFunction: iamWebFunction(stack),
    staticAssets: [{ directory, urlPrefix: "/_next/static/" }],
  });
  return stack;
}

// AWS managed AllViewerExceptHostHeader origin request policy.
const allViewerExceptHostHeaderPolicyId = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
const dynamicMethods = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"];

test("routes dynamic traffic to the Web Function endpoint with the viewer Host excluded", () => {
  const stack = deliveryStack("DynamicOriginStack");
  const template = Template.fromStack(stack);
  const endpointId = logicalIdWhere(template, "AWS::Lambda::WebFunctionEndpoint", () => true);
  const lambdaOacId = logicalIdWhere(template, "AWS::CloudFront::OriginAccessControl", (resource) =>
    resource.Properties.OriginAccessControlConfig.OriginAccessControlOriginType === "lambda");

  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({
        TargetOriginId: Match.anyValue(),
        AllowedMethods: dynamicMethods,
        ViewerProtocolPolicy: "https-only",
        OriginRequestPolicyId: allViewerExceptHostHeaderPolicyId,
      }),
      Origins: Match.arrayWith([
        Match.objectLike({
          DomainName: { "Fn::GetAtt": [endpointId, "DomainName"] },
          OriginAccessControlId: { "Fn::GetAtt": [lambdaOacId, "Id"] },
          CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: "https-only" }),
        }),
      ]),
    },
  });
});

test("keys the dynamic cache policy only on Authorization with a one-second per-identity TTL", () => {
  const template = Template.fromStack(deliveryStack("DynamicCachePolicyStack"));
  const dynamicPolicyId = logicalIdWhere(template, "AWS::CloudFront::CachePolicy", (resource) =>
    resource.Properties.CachePolicyConfig.DefaultTTL === 1);

  template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
    CachePolicyConfig: {
      DefaultTTL: 1,
      MinTTL: 1,
      MaxTTL: 1,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["Authorization"] },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
        EnableAcceptEncodingGzip: false,
        EnableAcceptEncodingBrotli: false,
      },
    },
  });
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({
        CachePolicyId: { Ref: dynamicPolicyId },
      }),
    },
  });
});

test("attaches a viewer-request function that overwrites the forwarded host and protocol", () => {
  const template = Template.fromStack(deliveryStack("ProxyHeadersStack"));
  const functionId = logicalIdWhere(template, "AWS::CloudFront::Function", () => true);

  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({
        FunctionAssociations: [
          {
            EventType: "viewer-request",
            FunctionARN: { "Fn::GetAtt": [functionId, "FunctionARN"] },
          },
        ],
      }),
    },
  });
  // Static behaviors need no request rewriting; the proxy context applies to the Web Function origin only.
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!;
  const staticBehavior = distribution.Properties.DistributionConfig.CacheBehaviors[0];
  expect(staticBehavior.FunctionAssociations).toBeUndefined();
});

test("the deployed viewer-request function replaces client-supplied forwarded headers with the viewer context", () => {
  const handler = deployedViewerRequestHandler(Template.fromStack(deliveryStack("ProxyHandlerStack")));
  const forwarded = handler({
    request: {
      uri: "/dashboard",
      headers: {
        host: { value: "d111abc.cloudfront.net" },
        "x-forwarded-host": { value: "attacker.example" },
        "x-forwarded-proto": { value: "http" },
      },
    },
  });

  expect(forwarded.uri).toBe("/dashboard");
  expect(forwarded.headers["x-forwarded-host"]).toEqual({ value: "d111abc.cloudfront.net" });
  expect(forwarded.headers["x-forwarded-proto"]).toEqual({ value: "https" });
});

test("the deployed viewer-request function removes client-supplied Forwarded and replaces every duplicate forwarded host value", () => {
  const handler = deployedViewerRequestHandler(Template.fromStack(deliveryStack("ProxyForwardedStack")));
  const rewritten = handler({
    request: {
      uri: "/dashboard",
      headers: {
        host: { value: "d111abc.cloudfront.net" },
        forwarded: { value: 'for=198.51.100.9;host=attacker.example;proto=http' },
        "x-forwarded-host": {
          value: "attacker.example",
          multiValue: [{ value: "attacker.example" }, { value: "evil.example" }],
        },
        "x-forwarded-proto": { value: "http" },
      },
    },
  });

  expect(rewritten.headers.forwarded).toBeUndefined();
  expect(rewritten.headers["x-forwarded-host"]).toEqual({ value: "d111abc.cloudfront.net" });
  expect(rewritten.headers["x-forwarded-proto"]).toEqual({ value: "https" });
});

test("the deployed viewer-request function refuses a request without a viewer Host", () => {
  const handler = deployedViewerRequestHandler(Template.fromStack(deliveryStack("ProxyNoHostStack")));
  expect(handler({ request: { uri: "/", headers: {} } })).toEqual({
    statusCode: 400,
    statusDescription: "Bad Request",
  });
});

test("forwards cookies, query strings, and dynamic headers through the managed AllViewerExceptHostHeader policy", () => {
  const template = Template.fromStack(deliveryStack("DynamicForwardingPolicyStack"));
  // The managed policy forwards all viewer headers except Host, plus all cookies and query strings.
  // Cookies and query strings are not cache keys; Authorization isolates identities for the 1-second TTL.
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({ OriginRequestPolicyId: allViewerExceptHostHeaderPolicyId }),
    },
  });
  expect(Object.values(template.findResources("AWS::CloudFront::OriginRequestPolicy"))).toEqual([]);
});

test("applies HSTS, nosniff, and framing headers without a guessed content security policy", () => {
  const template = Template.fromStack(deliveryStack("SecurityHeadersStack"));
  const policyId = logicalIdWhere(template, "AWS::CloudFront::ResponseHeadersPolicy", () => true);

  template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
    ResponseHeadersPolicyConfig: {
      SecurityHeadersConfig: Match.objectLike({
        StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: true },
        ContentTypeOptions: { Override: true },
        FrameOptions: { FrameOption: "DENY", Override: true },
        ContentSecurityPolicy: Match.absent(),
      }),
    },
  });
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: { Ref: policyId } }),
      CacheBehaviors: [Match.objectLike({ ResponseHeadersPolicyId: { Ref: policyId } })],
    },
  });
});

test("caches static assets for one immutable year without forwarding cookies, query strings, or Authorization", () => {
  const template = Template.fromStack(deliveryStack("StaticCachePolicyStack"));
  const staticPolicyId = logicalIdWhere(template, "AWS::CloudFront::CachePolicy", (resource) =>
    resource.Properties.CachePolicyConfig.DefaultTTL === 31536000);

  template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
    CachePolicyConfig: {
      DefaultTTL: 31536000,
      MaxTTL: 31536000,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: { HeaderBehavior: "none" },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
      },
    },
  });
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      CacheBehaviors: [
        Match.objectLike({
          PathPattern: "/_next/static/*",
          AllowedMethods: ["GET", "HEAD"],
          ViewerProtocolPolicy: "https-only",
          CachePolicyId: { Ref: staticPolicyId },
          OriginRequestPolicyId: Match.absent(),
        }),
      ],
    },
  });
});

test("enables gzip and brotli Accept-Encoding support on the static cache policy only", () => {
  const template = Template.fromStack(deliveryStack("StaticCompressionStack"));
  const staticPolicyId = logicalIdWhere(template, "AWS::CloudFront::CachePolicy", (resource) =>
    resource.Properties.CachePolicyConfig.DefaultTTL === 31536000);
  const dynamicPolicyId = logicalIdWhere(template, "AWS::CloudFront::CachePolicy", (resource) =>
    resource.Properties.CachePolicyConfig.DefaultTTL === 1);

  template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
    CachePolicyConfig: {
      DefaultTTL: 31536000,
      ParametersInCacheKeyAndForwardedToOrigin: {
        EnableAcceptEncodingGzip: true,
        EnableAcceptEncodingBrotli: true,
      },
    },
  });
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      CacheBehaviors: [Match.objectLike({ CachePolicyId: { Ref: staticPolicyId } })],
      DefaultCacheBehavior: Match.objectLike({ CachePolicyId: { Ref: dynamicPolicyId } }),
    },
  });
});

test("uploads each static mapping with pruning disabled, immutable cache-control, and no invalidation", () => {
  const template = Template.fromStack(deliveryStack("StaticUploadStack"));

  expect(staticUploads(template, "_next/static")).toHaveLength(1);
  template.hasResourceProperties("Custom::CDKBucketDeployment", {
    DestinationBucketKeyPrefix: "_next/static",
    Prune: false,
    RetainOnDelete: true,
    SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" },
    DistributionId: Match.absent(),
  });
});

test("keeps a previous build's keys configured with pruning disabled after a second build", () => {
  const buildOne = mkdtempSync(path.join(fixture, "build-one-"));
  writeFileSync(path.join(buildOne, "chunk-1.js"), "export const one = 1;");
  const buildTwo = mkdtempSync(path.join(fixture, "build-two-"));
  writeFileSync(path.join(buildTwo, "chunk-2.js"), "export const two = 2;");

  const first = Template.fromStack(deliveryStack("FirstBuildStack", buildOne));
  const second = Template.fromStack(deliveryStack("SecondBuildStack", buildTwo));
  const firstUpload = Object.values(first.findResources("Custom::CDKBucketDeployment")).find(
    (resource) => resource.Properties.DestinationBucketKeyPrefix === "_next/static",
  )!;
  const secondUpload = Object.values(second.findResources("Custom::CDKBucketDeployment")).find(
    (resource) => resource.Properties.DestinationBucketKeyPrefix === "_next/static",
  )!;

  // Synthesized configuration only: S3 retention of the previous objects is verified live, not here.
  for (const upload of [firstUpload, secondUpload]) {
    expect(upload.Properties.Prune).toBe(false);
    expect(upload.Properties.RetainOnDelete).toBe(true);
    expect(upload.Properties.DistributionId).toBeUndefined();
  }
  expect(firstUpload.Properties.SourceObjectKeys).not.toEqual(secondUpload.Properties.SourceObjectKeys);
});

test("orders the Revision after every static upload and keeps uploads independent of the distribution", () => {
  const template = Template.fromStack(deliveryStack("OrderingStack"));
  const json = template.toJSON() as CloudFormationTemplate;
  const graph = dependencyGraph(json);
  const revisionId = logicalIdWhere(template, "AWS::Lambda::WebFunctionRevision", () => true);
  const endpointId = logicalIdWhere(template, "AWS::Lambda::WebFunctionEndpoint", () => true);
  const distributionId = logicalIdWhere(template, "AWS::CloudFront::Distribution", () => true);
  const uploadIds = staticUploads(template, "_next/static");

  expect(uploadIds).toHaveLength(1);
  expect(graph.get(revisionId)).toContain(uploadIds[0]);
  expect(graph.get(endpointId)).toContain(revisionId);
  for (const uploadId of uploadIds) {
    expect(reachableFrom(graph, uploadId).has(distributionId)).toBe(false);
  }
  expect(JSON.stringify(json.Resources[revisionId])).not.toContain(distributionId);
});

test("synthesizes an acyclic CloudFormation dependency graph", () => {
  const template = Template.fromStack(deliveryStack("AcyclicStack"));
  expect(findCycle(dependencyGraph(template.toJSON() as CloudFormationTemplate))).toBeUndefined();
});
