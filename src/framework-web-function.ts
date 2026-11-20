import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
	CfnWebFunctionEndpoint,
	CfnWebFunctionRevision,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { z } from "zod";
import { WebFunction } from "./web-function";
import { WebFunctionDelivery } from "./web-function-delivery";
import { WebFunctionAuthType, WebFunctionEndpointType } from "./web-function-options";

/**
 * One IAM permission statement applied to the revision execution role.
 * Anything else (least privilege or standard CDK grant APIs) can use
 * `site.webFunction.executionRole` or `site.webFunction.grantPrincipal` directly.
 */
export interface WebFunctionPermission {
	/** IAM actions, e.g. "dynamodb:GetItem" or ["s3:GetObject", "s3:PutObject"]. */
	readonly actions: string | string[];
	/**
	 * Resource ARNs for any AWS service. Pass the construct's ARN property
	 * directly, e.g. bucket.bucketArn, table.tableArn, queue.queueArn,
	 * topic.topicArn, cluster.clusterArn — or a literal ARN string.
	 */
	readonly resources: string[];
}

/**
 * Properties shared by the framework Web Function constructs.
 *
 * `authType`, `endpointType`, and `cognito` are deliberately not exposed: the
 * internal `WebFunctionDelivery` hard-requires a same-stack IamAuth HomeRegion
 * Web Function, so auth/endpoint knobs would only ever fail inside the delivery,
 * and Cognito requires ApplicationManaged. Consumers who need other combinations
 * compose the underlying `WebFunction` (with `WebFunctionDelivery` where its
 * IamAuth/HomeRegion requirement fits) directly.
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
	/** IAM permission statements applied to the execution role; each entry becomes one Allow statement. */
	readonly permissions?: WebFunctionPermission[];
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
export interface FrameworkDefinition {
	/** Framework display name used in validation messages. */
	readonly name: string;
	/** Launcher file expected at the artifact root; "index.js" for every framework. */
	readonly launcher: string;
	/** Content-hashed static asset directory segments, relative to the artifact root. */
	readonly assetDirectory: readonly string[];
	/** CloudFront path prefix the asset directory is served under. */
	readonly urlPrefix: string;
}

/** Next.js layout: `index.js` launcher, `.next/static` assets under `/_next/static/`. */
export const NEXTJS_FRAMEWORK: FrameworkDefinition = {
	name: "Next.js",
	launcher: "index.js",
	assetDirectory: [".next", "static"],
	urlPrefix: "/_next/static/",
};

/** TanStack Start layout: `index.js` launcher, `dist/client/assets` assets under `/assets/`. */
export const TANSTACK_FRAMEWORK: FrameworkDefinition = {
	name: "TanStack Start",
	launcher: "index.js",
	assetDirectory: ["dist", "client", "assets"],
	urlPrefix: "/assets/",
};

/** Nuxt layout: `index.js` launcher, `.output/public/_nuxt` assets under `/_nuxt/`. */
export const NUXT_FRAMEWORK: FrameworkDefinition = {
	name: "Nuxt",
	launcher: "index.js",
	assetDirectory: [".output", "public", "_nuxt"],
	urlPrefix: "/_nuxt/",
};

/** Astro layout: `index.js` launcher, `dist/client/_astro` assets under `/_astro/`. */
export const ASTRO_FRAMEWORK: FrameworkDefinition = {
	name: "Astro",
	launcher: "index.js",
	assetDirectory: ["dist", "client", "_astro"],
	urlPrefix: "/_astro/",
};

// Each permission entry becomes one Allow PolicyStatement. jsii forbids readonly
// arrays and anonymous object unions in public props, so `resources` is a plain
// string[] (consumers pass any construct's ARN property or a literal ARN).
const permissionSchema = z.object({
	actions: z.union(
		[
			z.string().min(1, "permission actions must not be an empty string"),
			z
				.array(z.string().min(1, "permission actions must not contain empty strings"))
				.min(1, "permission actions must not be an empty array"),
		],
		{
			error:
				"permission actions must be a non-empty string or a non-empty array of non-empty strings",
		},
	),
	resources: z
		.array(z.string().min(1, "permission resources must not contain empty strings"))
		.min(1, "permission resources must not be an empty array"),
});

const frameworkPropsSchema = z
	.object({
		artifactDirectory: z.string().min(1),
		functionName: z.string().min(1),
		endpointName: z.string().min(1).optional(),
		environmentVariables: z.record(z.string(), z.string()).optional(),
		permissions: z.array(permissionSchema).optional(),
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
			.object({ rateLimit: z.number().int().nonnegative().max(10000).optional() })
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
 * permission statements are applied to the revision execution role.
 *
 * Internal base shared by the per-framework constructs; imported across the
 * construct files but not re-exported from `src/index.ts`.
 *
 * @internal jsii hidden base class: exported from the module for the per-framework
 * constructs, excluded from the assembly.
 */
export class FrameworkWebFunctionBase extends Construct {
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
		// Validate and parse before attaching to the tree so a rejected construct
		// never leaves an orphaned partial node behind.
		const parsed = frameworkPropsSchema.parse(props);
		assertFrameworkLayout(framework, parsed.artifactDirectory);
		super(scope, id);

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
		for (const permission of parsed.permissions ?? []) {
			const actions = typeof permission.actions === "string"
				? [permission.actions]
				: permission.actions;
			role.addToPolicy(new PolicyStatement({
				effect: Effect.ALLOW,
				actions,
				resources: permission.resources,
			}));
		}
	}
}
