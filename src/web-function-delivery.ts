import { statSync } from "node:fs";
import path from "node:path";
import { Duration, Names, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
	AccessLevel,
	AllowedMethods,
	CacheHeaderBehavior,
	CachePolicy,
	CfnOriginAccessControl,
	Distribution,
	Function as CloudFrontFunction,
	FunctionCode,
	FunctionEventType,
	FunctionRuntime,
	HeadersFrameOption,
	OriginProtocolPolicy,
	OriginRequestPolicy,
	ResponseHeadersPolicy,
	type BehaviorOptions,
	ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { CfnResourcePolicy } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { z } from "zod";
import type { WebFunction } from "./web-function";
import { WebFunctionAuthType, WebFunctionEndpointType } from "./web-function-options";
import { proxyHeadersFunctionCode } from "./web-function-proxy-headers";

/** An immutable browser asset directory served under a CloudFront path prefix. */
export interface WebFunctionStaticAssetMapping {
	/** Built asset directory whose files are served under the URL prefix. */
	readonly directory: string;
	/** Absolute directory prefix, such as `/_next/static/`. Overlapping prefixes are rejected. */
	readonly urlPrefix: string;
}

/** Properties for exposing a Web Function through CloudFront with private static assets. */
export interface WebFunctionDeliveryProps {
	/** Same-stack, IamAuth, HomeRegion Web Function that serves dynamic traffic. */
	readonly webFunction: WebFunction;
	/** Immutable static asset mappings. At least one is required. */
	readonly staticAssets: WebFunctionStaticAssetMapping[];
	/** Asset bucket removal policy. RETAIN by default; DESTROY also deletes asset objects. */
	readonly removalPolicy?: RemovalPolicy;
}

/**
 * Normalizes a static asset URL prefix to an absolute directory form with a trailing slash.
 * Returns undefined for the root, wildcards, traversal, empty segments, encoded, or non-ASCII characters.
 */
function normalizeUrlPrefix(urlPrefix: string): string | undefined {
	if (!urlPrefix.startsWith("/") || /[*?#%\\\s\p{Cc}]|[^\x00-\x7F]/u.test(urlPrefix)) return undefined;
	const body = urlPrefix.replace(/\/$/, "");
	if (body === "") return undefined;
	const segments = body.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		return undefined;
	}
	return `/${segments.join("/")}/`;
}

const staticAssetMappingSchema = z
	.object({
		directory: z.string().min(1),
		urlPrefix: z.string().min(1).transform((value, ctx) => {
			const normalized = normalizeUrlPrefix(value);
			if (normalized === undefined) {
				ctx.addIssue({
					code: "custom",
					message: `Static asset URL prefix "${value}" must be an absolute ASCII directory path without the root, wildcards, traversal, empty segments, or encoded characters`,
				});
				return z.NEVER;
			}
			return normalized;
		}),
	})
	.superRefine((mapping, ctx) => {
		const resolved = path.resolve(mapping.directory);
		if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
			ctx.addIssue({
				code: "custom",
				path: ["directory"],
				message: `Static asset directory "${mapping.directory}" must be an existing directory`,
			});
		}
	});

const WebFunctionDeliveryPropsSchema = z
	.object({
		staticAssets: z.array(staticAssetMappingSchema).min(1),
		removalPolicy: z
			.custom<RemovalPolicy>(
				(value) => value === RemovalPolicy.RETAIN || value === RemovalPolicy.DESTROY,
				{ message: "Asset bucket removal policy must be RETAIN or DESTROY" },
			)
			.optional(),
	})
	.superRefine((props, ctx) => {
		props.staticAssets.forEach((mapping, index) => {
			for (const earlier of props.staticAssets.slice(0, index)) {
				if (
					mapping.urlPrefix.startsWith(earlier.urlPrefix) ||
					earlier.urlPrefix.startsWith(mapping.urlPrefix)
				) {
					ctx.addIssue({
						code: "custom",
						path: ["staticAssets", index, "urlPrefix"],
						message: `Static asset URL prefixes overlap: ${earlier.urlPrefix} and ${mapping.urlPrefix}`,
					});
				}
			}
		});
	});

/**
 * Exposes an IAM-protected Web Function through a CloudFront distribution. Explicit static
 * prefixes are served from a private S3 asset bucket; all other requests go to the Web
 * Function endpoint through a Lambda Web Function origin access control.
 *
 * The delivery owns the Web Function's CloudFront invoke policy, so at most one delivery
 * can be attached to a Web Function. Dynamic responses are not cached by CloudFront.
 * A throwing constructor can leave partially created constructs in the tree, so callers
 * must discard the app rather than catch the error and continue synthesizing it.
 *
 * ```mermaid
 * architecture-beta
 *   group deliveryGroup(logos:aws-lambda)[WebFunction delivery]
 *   service viewer(internet)[HTTPS viewers] in deliveryGroup
 *   service distribution(cloud)[CloudFront distribution] in deliveryGroup
 *   service staticOac(logos:aws-iam)[S3 origin access control] in deliveryGroup
 *   service assetBucket(logos:aws-s3)[Private static asset bucket] in deliveryGroup
 *   service lambdaOac(logos:aws-iam)[Lambda origin access control] in deliveryGroup
 *   service endpoint(logos:aws-lambda)[WebFunction endpoint] in deliveryGroup
 *   service invokePolicy(logos:aws-iam)[Invoke resource policy] in deliveryGroup
 *   viewer:R -- L:distribution
 *   distribution:B -- T:staticOac
 *   staticOac:R -- L:assetBucket
 *   distribution:R -- L:lambdaOac
 *   lambdaOac:R -- L:endpoint
 *   invokePolicy:T -- B:endpoint
 * ```
 */
export class WebFunctionDelivery extends Construct {
	/** The CloudFront distribution that serves static assets and dynamic traffic. */
	public readonly distribution: Distribution;
	/** The private bucket holding static assets. */
	public readonly assetBucket: Bucket;
	/** The public HTTPS URL of the CloudFront distribution. */
	public readonly url: string;

	constructor(scope: Construct, id: string, props: WebFunctionDeliveryProps) {
		super(scope, id);

		const { webFunction } = props;
		if (Stack.of(webFunction) !== Stack.of(this)) {
			throw new Error("WebFunctionDelivery must be in the same stack as its WebFunction");
		}
		if (webFunction.authType.value !== WebFunctionAuthType.IAM_AUTH.value) {
			throw new Error("WebFunctionDelivery requires a WebFunction with IamAuth authentication");
		}
		if (webFunction.endpointType.value !== WebFunctionEndpointType.HOME_REGION.value) {
			throw new Error("WebFunctionDelivery requires a WebFunction with a HomeRegion endpoint");
		}
		const parsed = WebFunctionDeliveryPropsSchema.parse({
			staticAssets: props.staticAssets,
			removalPolicy: props.removalPolicy,
		});
		const removalPolicy = parsed.removalPolicy ?? RemovalPolicy.RETAIN;
		webFunction._assertDeliveryAvailable();

		this.assetBucket = new Bucket(this, "AssetBucket", {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			removalPolicy,
			autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
		});

		const webFunctionOriginAccessControl = new CfnOriginAccessControl(
			this,
			"WebFunctionOriginAccessControl",
			{
				originAccessControlConfig: {
					name: Names.uniqueResourceName(this, { maxLength: 64 }),
					description: "Signs CloudFront requests to the Web Function endpoint",
					originAccessControlOriginType: "lambda",
					signingBehavior: "always-amz-auth",
					signingProtocol: "sigv4",
				},
			},
		);
		const webFunctionOrigin = new HttpOrigin(webFunction.endpointDomainName, {
			originAccessControlId: webFunctionOriginAccessControl.attrId,
			protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
		});
		const assetOrigin = S3BucketOrigin.withOriginAccessControl(this.assetBucket, {
			originAccessLevels: [AccessLevel.READ],
		});

		const immutableAssetTtl = Duration.days(365);
		const staticAssetCachePolicy = new CachePolicy(this, "StaticAssetCachePolicy", {
			defaultTtl: immutableAssetTtl,
			maxTtl: immutableAssetTtl,
			enableAcceptEncodingGzip: true,
			enableAcceptEncodingBrotli: true,
		});
		// CloudFront rejects an Authorization cache-key header list when caching is disabled (all TTLs 0):
		// "The parameter HeaderBehavior is invalid for policy with caching disabled" (live, 2026-11-18).
		// A one-second TTL is the smallest practical value that keeps Authorization in the cache key, so
		// responses are isolated per viewer identity; a same-identity response may be reused for at most 1s.
		// Cookies and query strings are deliberately not cache keys; the origin request policy still forwards them.
		const dynamicTtl = Duration.seconds(1);
		const dynamicCachePolicy = new CachePolicy(this, "DynamicCachePolicy", {
			defaultTtl: dynamicTtl,
			minTtl: dynamicTtl,
			maxTtl: dynamicTtl,
			headerBehavior: CacheHeaderBehavior.allowList("Authorization"),
		});
		const proxyHeadersFunction = new CloudFrontFunction(this, "ProxyHeadersFunction", {
			code: FunctionCode.fromInline(proxyHeadersFunctionCode),
			runtime: FunctionRuntime.JS_2_0,
		});
		const responseHeadersPolicy = new ResponseHeadersPolicy(this, "SecurityHeadersPolicy", {
			securityHeadersBehavior: {
				strictTransportSecurity: { accessControlMaxAge: Duration.days(365), override: true },
				contentTypeOptions: { override: true },
				frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
			},
		});

		// Uploads depend on no distribution, so the Revision can wait for them without a cycle. Pruning is
		// disabled and no distribution is given, so earlier hashed objects are neither deleted nor invalidated.
		const staticUploads: BucketDeployment[] = [];
		const additionalBehaviors: Record<string, BehaviorOptions> = {};
		for (const mapping of parsed.staticAssets) {
			staticUploads.push(
				new BucketDeployment(this, `StaticAssets${mapping.urlPrefix}`, {
					sources: [Source.asset(path.resolve(mapping.directory))],
					destinationBucket: this.assetBucket,
					destinationKeyPrefix: mapping.urlPrefix.slice(1, -1),
					prune: false,
					retainOnDelete: removalPolicy === RemovalPolicy.RETAIN,
					cacheControl: [
						CacheControl.setPublic(),
						CacheControl.maxAge(immutableAssetTtl),
						CacheControl.immutable(),
					],
				}),
			);
			additionalBehaviors[`${mapping.urlPrefix}*`] = {
				origin: assetOrigin,
				viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
				allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
				cachePolicy: staticAssetCachePolicy,
				responseHeadersPolicy,
			};
		}
		this.distribution = new Distribution(this, "Distribution", {
			defaultBehavior: {
				origin: webFunctionOrigin,
				viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
				allowedMethods: AllowedMethods.ALLOW_ALL,
				cachePolicy: dynamicCachePolicy,
				originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
				responseHeadersPolicy,
				functionAssociations: [
					{ function: proxyHeadersFunction, eventType: FunctionEventType.VIEWER_REQUEST },
				],
			},
			additionalBehaviors,
		});
		this.url = `https://${this.distribution.distributionDomainName}`;

		new CfnResourcePolicy(this, "WebFunctionInvokePolicy", {
			resourceArn: webFunction.functionArn,
			policyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Service: "cloudfront.amazonaws.com" },
						Action: "lambda:InvokeWebFunctionEndpoint",
						Resource: webFunction.endpointArn,
						Condition: {
							StringEquals: { "aws:SourceArn": this.distribution.distributionArn },
						},
					},
				],
			},
		});
		webFunction._attachDelivery(this, staticUploads);
	}
}
