import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
	CfnWebFunctionEndpoint,
	CfnWebFunctionRevision,
} from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { IQueue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { z } from "zod";
import { WebFunction } from "./web-function";
import { WebFunctionDelivery } from "./web-function-delivery";
import { WebFunctionAuthType, WebFunctionEndpointType } from "./web-function-options";

/**
 * Service grants applied to the framework construct's execution role.
 * Anything else (least privilege or other services) can use
 * `site.webFunction.executionRole` or `site.webFunction.grantPrincipal` directly.
 */
export interface WebFunctionPermissions {
	/** DynamoDB tables granted read/write data access. */
	readonly dynamodb?: ITable[];
	/** S3 buckets granted read/write object access. */
	readonly s3?: IBucket[];
	/** SQS queues granted message-send access (grantSendMessages; batch send is not included in current aws-cdk-lib). */
	readonly sqs?: IQueue[];
}

/**
 * Properties shared by the framework Web Function constructs.
 *
 * `authType`, `endpointType`, and `cognito` are deliberately not exposed: the
 * internal `WebFunctionDelivery` hard-requires a same-stack IamAuth HomeRegion
 * Web Function, so auth/endpoint knobs would only ever fail inside the delivery,
 * and Cognito requires ApplicationManaged. Consumers who need other combinations
 * compose `WebFunction` and `WebFunctionDelivery` directly.
 */
export interface FrameworkWebFunctionProps {
	/** Prebuilt artifact root staged by the framework's build-artifact script. */
	readonly artifactDirectory: string;
	/** Name assigned to the Lambda Web Function. */
	readonly functionName: string;
	/** Name assigned to the HTTPS endpoint; defaults to "prod". */
	readonly endpointName?: string;
	/** Environment variables passed to the revision. NODE_ENV defaults to "production". */
	readonly environmentVariables?: { readonly [key: string]: string };
	/** Service grants applied to the execution role. */
	readonly permissions?: WebFunctionPermissions;
	/** Asset bucket removal policy. RETAIN by default, matching WebFunctionDelivery. */
	readonly removalPolicy?: RemovalPolicy;
	/** Optional description for the endpoint. */
	readonly description?: string;
	/** Optional endpoint execution-environment scaling limit. */
	readonly scalingConfig?: CfnWebFunctionEndpoint.ScalingConfigProperty;
	/** Optional endpoint request-rate limit. */
	readonly throttleConfig?: CfnWebFunctionEndpoint.ThrottleConfigProperty;
	/** Optional request timeout in seconds (3–900). */
	readonly timeoutSeconds?: number;
	/** Optional maximum concurrent requests per execution environment (1–128). */
	readonly maxConcurrencyPerEnvironment?: number;
	/** Optional CloudWatch logging configuration for the revision. */
	readonly loggingConfig?: CfnWebFunctionRevision.LoggingConfigProperty;
}

/** Per-framework artifact layout: launcher, hashed asset directory, and URL prefix. */
interface FrameworkDefinition {
	/** Framework display name used in validation messages. */
	readonly name: string;
	/** Launcher file expected at the artifact root; "index.js" for every framework. */
	readonly launcher: string;
	/** Content-hashed static asset directory segments, relative to the artifact root. */
	readonly assetDirectory: readonly string[];
	/** CloudFront path prefix the asset directory is served under. */
	readonly urlPrefix: string;
}

// ITable, IBucket, and IQueue are TypeScript interfaces without a runtime class,
// so the arrays are validated with duck-typed ARN predicates; the grant calls
// themselves fail fast if a wrong shape is passed.
const tableSchema = z.custom<ITable>(
	(value) =>
		typeof value === "object" && value !== null &&
		typeof (value as { tableArn?: unknown }).tableArn === "string",
	{ message: "Expected a DynamoDB ITable construct" },
);
const bucketSchema = z.custom<IBucket>(
	(value) =>
		typeof value === "object" && value !== null &&
		typeof (value as { bucketArn?: unknown }).bucketArn === "string",
	{ message: "Expected an S3 IBucket construct" },
);
const queueSchema = z.custom<IQueue>(
	(value) =>
		typeof value === "object" && value !== null &&
		typeof (value as { queueArn?: unknown }).queueArn === "string",
	{ message: "Expected an SQS IQueue construct" },
);

const frameworkPropsSchema = z
	.object({
		artifactDirectory: z.string().min(1),
		functionName: z.string().min(1),
		endpointName: z.string().min(1).optional(),
		environmentVariables: z.record(z.string(), z.string()).optional(),
		permissions: z
			.object({
				dynamodb: z.array(tableSchema).optional(),
				s3: z.array(bucketSchema).optional(),
				sqs: z.array(queueSchema).optional(),
			})
			.optional(),
		removalPolicy: z
			.custom<RemovalPolicy>(
				(value) =>
					value === RemovalPolicy.RETAIN || value === RemovalPolicy.DESTROY,
				{ message: "Asset bucket removal policy must be RETAIN or DESTROY" },
			)
			.optional(),
		description: z.string().optional(),
		scalingConfig: z
			.object({ maxEnvironments: z.number().int().positive().optional() })
			.optional(),
		throttleConfig: z
			.object({ rateLimit: z.number().int().nonnegative().optional() })
			.optional(),
		maxConcurrencyPerEnvironment: z.number().int().min(1).max(128).optional(),
		timeoutSeconds: z.number().int().min(3).max(900).optional(),
		loggingConfig: z
			.object({
				applicationLogLevel: z
					.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"])
					.optional(),
				logGroup: z.string().min(1).optional(),
				systemLogLevel: z.enum(["DEBUG", "INFO", "WARN"]).optional(),
			})
			.optional(),
	})
	.superRefine((props, ctx) => {
		if (props.environmentVariables?.AWS_LAMBDA_HTTP_ENDPOINT !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["environmentVariables", "AWS_LAMBDA_HTTP_ENDPOINT"],
				message: "AWS_LAMBDA_HTTP_ENDPOINT is reserved",
			});
		}
	});

/**
 * Verifies the framework artifact layout at synthesis: the artifact root, its
 * launcher file, and its hashed static asset directory must all exist, or the
 * error names the framework and points at the build-artifact script.
 */
function assertFrameworkLayout(
	framework: FrameworkDefinition,
	artifactDirectory: string,
): void {
	const buildHint =
		"run the framework's build-artifact script to produce a complete artifact";
	let artifactRoot: string;
	try {
		artifactRoot = realpathSync(artifactDirectory);
		if (!statSync(artifactRoot).isDirectory()) {
			throw new Error("not a directory");
		}
	} catch {
		throw new Error(
			`${framework.name} artifact directory "${artifactDirectory}" must be an existing directory; ${buildHint}`,
		);
	}
	const launcher = path.join(artifactRoot, framework.launcher);
	if (!statSync(launcher, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(
			`${framework.name} artifact must contain the required launcher file "${framework.launcher}" under "${artifactDirectory}"; ${buildHint}`,
		);
	}
	const assetDirectory = path.join(artifactRoot, ...framework.assetDirectory);
	if (!statSync(assetDirectory, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(
			`${framework.name} artifact must contain the required static asset directory "${framework.assetDirectory.join("/")}" under "${artifactDirectory}"; ${buildHint}`,
		);
	}
}

/**
 * Deploys a prebuilt framework artifact as a Lambda Web Function behind a
 * CloudFront delivery: the launcher runs as the function code, the framework's
 * content-hashed static assets are served from a private S3 bucket, and optional
 * permissions are granted to the revision execution role.
 */
class FrameworkWebFunctionBase extends Construct {
	/** The deployed Web Function (endpoint is IamAuth + HomeRegion). */
	public readonly webFunction: WebFunction;
	/** The CloudFront delivery serving static assets and dynamic traffic. */
	public readonly delivery: WebFunctionDelivery;

	constructor(
		scope: Construct,
		id: string,
		props: FrameworkWebFunctionProps,
		framework: FrameworkDefinition,
	) {
		super(scope, id);
		const parsed = frameworkPropsSchema.parse(props);
		assertFrameworkLayout(framework, parsed.artifactDirectory);

		this.webFunction = new WebFunction(this, "App", {
			artifact: {
				directory: parsed.artifactDirectory,
				entrypoint: framework.launcher,
			},
			functionName: parsed.functionName,
			// Fixed: the delivery below hard-requires this combination.
			authType: WebFunctionAuthType.IAM_AUTH,
			endpointType: WebFunctionEndpointType.HOME_REGION,
			endpointName: parsed.endpointName ?? "prod",
			environmentVariables: {
				NODE_ENV: "production",
				...parsed.environmentVariables,
			},
			description: parsed.description,
			scalingConfig: parsed.scalingConfig,
			throttleConfig: parsed.throttleConfig,
			timeoutSeconds: parsed.timeoutSeconds,
			maxConcurrencyPerEnvironment: parsed.maxConcurrencyPerEnvironment,
			loggingConfig: parsed.loggingConfig,
		});

		this.delivery = new WebFunctionDelivery(this, "Delivery", {
			webFunction: this.webFunction,
			staticAssets: [
				{
					directory: path.join(
						parsed.artifactDirectory,
						...framework.assetDirectory,
					),
					urlPrefix: framework.urlPrefix,
				},
			],
			removalPolicy: parsed.removalPolicy,
		});

		const role = this.webFunction.executionRole;
		parsed.permissions?.dynamodb?.forEach((table) =>
			table.grantReadWriteData(role),
		);
		parsed.permissions?.s3?.forEach((bucket) => bucket.grantReadWrite(role));
		parsed.permissions?.sqs?.forEach((queue) => queue.grantSendMessages(role));
	}
}

/**
 * Deploys a prebuilt Next.js standalone artifact as a Lambda Web Function with a
 * CloudFront delivery. The launcher is `index.js` at the artifact root and the
 * content-hashed assets under `.next/static/` are served from private S3 under
 * `/_next/static/`.
 *
 * ```ts
 * new NextJsWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/nextjs/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: {
 *     dynamodb: [table], // grantReadWriteData
 *     s3: [bucket],      // grantReadWrite
 *     sqs: [queue],      // grantSendMessages
 *   },
 * });
 * ```
 */
export class NextJsWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, {
			name: "Next.js",
			launcher: "index.js",
			assetDirectory: [".next", "static"],
			urlPrefix: "/_next/static/",
		});
	}
}

/**
 * Deploys a prebuilt TanStack Start artifact as a Lambda Web Function with a
 * CloudFront delivery. The launcher is `index.js` at the artifact root and the
 * content-hashed assets under `dist/client/assets/` are served from private S3
 * under `/assets/`.
 *
 * ```ts
 * new TanStackWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/tanstack-start/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: {
 *     dynamodb: [table], // grantReadWriteData
 *     s3: [bucket],      // grantReadWrite
 *     sqs: [queue],      // grantSendMessages
 *   },
 * });
 * ```
 */
export class TanStackWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, {
			name: "TanStack Start",
			launcher: "index.js",
			assetDirectory: ["dist", "client", "assets"],
			urlPrefix: "/assets/",
		});
	}
}

/**
 * Deploys a prebuilt Nuxt (Nitro node-server) artifact as a Lambda Web Function
 * with a CloudFront delivery. The launcher is `index.js` at the artifact root and
 * the content-hashed assets under `.output/public/_nuxt/` are served from private
 * S3 under `/_nuxt/`.
 *
 * ```ts
 * new NuxtWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/nuxt/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: {
 *     dynamodb: [table], // grantReadWriteData
 *     s3: [bucket],      // grantReadWrite
 *     sqs: [queue],      // grantSendMessages
 *   },
 * });
 * ```
 */
export class NuxtWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, {
			name: "Nuxt",
			launcher: "index.js",
			assetDirectory: [".output", "public", "_nuxt"],
			urlPrefix: "/_nuxt/",
		});
	}
}

/**
 * Deploys a prebuilt Astro (SSR, `@astrojs/node`) artifact as a Lambda Web
 * Function with a CloudFront delivery. The launcher is `index.js` at the
 * artifact root and the content-hashed assets under `dist/client/_astro/` are
 * served from private S3 under `/_astro/`.
 *
 * ```ts
 * new AstroWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/astro/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: {
 *     dynamodb: [table], // grantReadWriteData
 *     s3: [bucket],      // grantReadWrite
 *     sqs: [queue],      // grantSendMessages
 *   },
 * });
 * ```
 */
export class AstroWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, {
			name: "Astro",
			launcher: "index.js",
			assetDirectory: ["dist", "client", "_astro"],
			urlPrefix: "/_astro/",
		});
	}
}
