import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ArnFormat,
	CfnOutput,
	Duration,
	Fn,
	RemovalPolicy,
	Token,
} from "aws-cdk-lib";
import {
	AccountRecovery,
	CfnManagedLoginBranding,
	FeaturePlan,
	ManagedLoginVersion,
	Mfa,
	OAuthScope,
	UserPool,
	UserPoolClient,
	UserPoolClientIdentityProvider,
	UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import {
	Effect,
	IGrantable,
	IPrincipal,
	PolicyStatement as IamPolicyStatement,
	Role,
	ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
	CfnWebFunction,
	CfnWebFunctionEndpoint,
	CfnWebFunctionRevision,
} from "aws-cdk-lib/aws-lambda";
import {
	BlockPublicAccess,
	Bucket,
	BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { z } from "zod";
import {
	WebFunctionAuthType,
	WebFunctionEndpointType,
} from "./web-function-options";
import { zipArtifactDirectory } from "./web-function-artifact";

const webFunctionArchiveDirectory = mkdtempSync(
	path.join(tmpdir(), "pawl-web-function-"),
);
process.on("exit", () => {
	rmSync(webFunctionArchiveDirectory, { recursive: true, force: true });
});

/** Optional Cognito resources for a separate browser frontend using code + PKCE. */
export interface WebFunctionCognitoOptions {
	/** Unique Cognito domain prefix, using lowercase letters, numbers, and hyphens. */
	readonly domainPrefix: string;
	/** Exact frontend OAuth callback URLs. HTTPS is required except for loopback development. */
	readonly callbackUrls: string[];
	/** Exact frontend logout URLs. Defaults to callbackUrls when omitted. */
	readonly logoutUrls?: string[];
}

/** A self-contained prebuilt Node.js deployment directory and startup file. */
export interface WebFunctionArtifactOptions {
	/** Root directory of the deployment package. */
	readonly directory: string;
	/** JavaScript startup file relative to the artifact root. */
	readonly entrypoint: string;
}

/** Properties for configuring a Lambda Web Function and its HTTPS endpoint. */
export interface WebFunctionProps {
	/** Path to the TypeScript or JavaScript HTTP server entry file. */
	readonly entry?: string;
	/** Prebuilt deployment directory; mutually exclusive with entry. */
	readonly artifact?: WebFunctionArtifactOptions;
	/** Name assigned to the Lambda Web Function. */
	readonly functionName: string;
	/** Authentication mode for the endpoint. */
	readonly authType: WebFunctionAuthType;
	/** Region behavior for the HTTPS endpoint. */
	readonly endpointType: WebFunctionEndpointType;
	/** Name assigned to the HTTPS endpoint. */
	readonly endpointName: string;
	/** Optional description for the endpoint. */
	readonly description?: string;
	/** AWS Regions used by a multi-region endpoint. */
	readonly regions?: string[];
	/** Optional endpoint execution-environment scaling limit. */
	readonly scalingConfig?: CfnWebFunctionEndpoint.ScalingConfigProperty;
	/** Optional endpoint request-rate limit. */
	readonly throttleConfig?: CfnWebFunctionEndpoint.ThrottleConfigProperty;
	/** Optional maximum concurrent requests per execution environment (1–128). */
	readonly maxConcurrencyPerEnvironment?: number;
	/** Optional request timeout in seconds (3–900). */
	readonly timeoutSeconds?: number;
	/** Optional environment variables passed to the revision execution environment. */
	readonly environmentVariables?: { readonly [key: string]: string };
	/** Optional CloudWatch logging configuration for the revision. */
	readonly loggingConfig?: CfnWebFunctionRevision.LoggingConfigProperty;
	/**
	 * Provision a retained user pool, public app client, and managed login domain.
	 * Requires APPLICATION_MANAGED. The application must still verify access tokens.
	 * Injects COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID into the revision.
	 */
	readonly cognito?: WebFunctionCognitoOptions;
}

const cognitoRedirectUrlSchema = z.string().refine((value) => {
	if (Token.isUnresolved(value)) return true;
	try {
		const url = new URL(value);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		return (
			!url.hash && !url.username && !url.password &&
			(url.protocol === "https:" || (url.protocol === "http:" && loopback))
		);
	} catch {
		return false;
	}
}, "Cognito URLs must use HTTPS (or HTTP loopback), without credentials or fragments");

const WebFunctionPropsSchema = z.object({
	entry: z.string().min(1).optional(),
	artifact: z.object({ directory: z.string().min(1), entrypoint: z.string().min(1) }).optional(),
	functionName: z.string().min(1),
	authType: z
		.custom<WebFunctionAuthType>(
			(value) => value instanceof WebFunctionAuthType,
			{ message: "Expected an instance of WebFunctionAuthType" },
		)
		.transform((option) => option.value),
	endpointType: z
		.custom<WebFunctionEndpointType>(
			(value) => value instanceof WebFunctionEndpointType,
			{ message: "Expected an instance of WebFunctionEndpointType" },
		)
		.transform((option) => option.value),
	endpointName: z.string().min(1),
	description: z.string().optional(),
	regions: z.array(z.string()).optional(),
	scalingConfig: z
		.object({ maxEnvironments: z.number().int().positive().optional() })
		.optional(),
	throttleConfig: z
		.object({ rateLimit: z.number().int().nonnegative().optional() })
		.optional(),
	maxConcurrencyPerEnvironment: z.number().int().min(1).max(128).optional(),
	timeoutSeconds: z.number().int().min(3).max(900).optional(),
	environmentVariables: z.record(z.string(), z.string()).optional(),
	cognito: z.object({
		domainPrefix: z.string().min(1).max(63).refine(
			(value) => Token.isUnresolved(value) || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value),
			"Invalid Cognito domain prefix",
		),
		callbackUrls: z.array(cognitoRedirectUrlSchema).min(1),
		logoutUrls: z.array(cognitoRedirectUrlSchema).min(1).optional(),
	}).optional(),
	loggingConfig: z
		.object({
			applicationLogLevel: z
				.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"])
				.optional(),
			logGroup: z.string().min(1).optional(),
			systemLogLevel: z.enum(["DEBUG", "INFO", "WARN"]).optional(),
		})
		.optional(),
}).superRefine((props, ctx) => {
	if (Boolean(props.entry) === Boolean(props.artifact)) {
		ctx.addIssue({ code: "custom", path: ["entry"], message: "Exactly one of entry or artifact is required" });
	}
	if (props.artifact) {
		const { directory, entrypoint } = props.artifact;
		if (path.isAbsolute(entrypoint) || path.win32.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes("..")) {
			ctx.addIssue({ code: "custom", path: ["artifact", "entrypoint"], message: "Artifact entrypoint must be relative and contain no traversal" });
		} else {
			try {
				const root = realpathSync(directory);
				if (!statSync(root).isDirectory()) throw new Error("not a directory");
				const resolved = realpathSync(path.resolve(root, entrypoint));
				const relative = path.relative(root, resolved);
				if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(resolved).isFile()) throw new Error("invalid entrypoint");
			} catch {
				ctx.addIssue({ code: "custom", path: ["artifact"], message: "Artifact root must be a directory and entrypoint a regular file within it" });
			}
		}
	}
	if (props.environmentVariables?.AWS_LAMBDA_HTTP_ENDPOINT !== undefined) {
		ctx.addIssue({ code: "custom", path: ["environmentVariables", "AWS_LAMBDA_HTTP_ENDPOINT"], message: "AWS_LAMBDA_HTTP_ENDPOINT is reserved" });
	}
	if (props.artifact && props.environmentVariables?.AWS_LAMBDA_NODEJS_ENTRYPOINT !== undefined && props.environmentVariables.AWS_LAMBDA_NODEJS_ENTRYPOINT !== props.artifact.entrypoint) {
		ctx.addIssue({ code: "custom", path: ["environmentVariables", "AWS_LAMBDA_NODEJS_ENTRYPOINT"], message: "Conflicts with artifact entrypoint" });
	}
	if (!props.cognito) return;
	if (props.authType !== WebFunctionAuthType.APPLICATION_MANAGED.value) {
		ctx.addIssue({
			code: "custom",
			path: ["cognito"],
			message: "Cognito requires APPLICATION_MANAGED authentication",
		});
	}
	for (const key of ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"]) {
		if (props.environmentVariables?.[key] !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["environmentVariables", key],
				message: `${key} is managed by the Cognito configuration`,
			});
		}
	}
});
type ParsedWebFunctionProps = z.infer<typeof WebFunctionPropsSchema>;

/**
 * Creates a Lambda WebFunction, endpoint, revision, and revision execution role.
 * The single TypeScript entry is bundled for Node.js, packaged as a ZIP, and copied
 * into a dedicated S3 bucket. A bucket policy grants the Lambda service read access
 * to that object while the CDK asset bucket remains private to deployment. The stack
 * owns the bucket and archive; outputs expose the function ARN and endpoint domain.
 *
 * ```mermaid
 * architecture-beta
 *   group functionGroup(logos:aws-lambda)[WebFunction deployment]
 *   service asset(disk)[Generated ZIP CDK asset] in functionGroup
 *   service deployment(logos:aws-s3)[Raw ZIP deployment] in functionGroup
 *   service bucket(logos:aws-s3)[Private code bucket and policy] in functionGroup
 *   service function(logos:aws-lambda)[WebFunction] in functionGroup
 *   service endpoint(logos:aws-lambda)[WebFunction endpoint] in functionGroup
 *   service revision(logos:aws-lambda)[WebFunction revision] in functionGroup
 *   service role(logos:aws-iam)[Revision execution role] in functionGroup
 *   service outputs(logos:aws-cloudformation)[Function and endpoint outputs] in functionGroup
 *   asset:R -- L:deployment
 *   deployment:R -- L:bucket
 *   bucket:R -- L:revision
 *   role:R -- L:revision
 *   function:R -- L:revision
 *   revision:R -- L:endpoint
 *   function:B -- T:outputs
 *   endpoint:R -- L:outputs
 * ```
 */
export class WebFunction extends Construct implements IGrantable {
	/** The ARN of the Lambda Web Function. */
	public readonly functionArn: string;
	/** The HTTPS domain name of the Lambda Web Function endpoint. */
	public readonly endpointDomainName: string;
	/** The ARN of the HTTPS endpoint. */
	public readonly endpointArn: string;
	/** Authentication mode configured for the endpoint. */
	public readonly authType: WebFunctionAuthType;
	/** Region behavior configured for the endpoint. */
	public readonly endpointType: WebFunctionEndpointType;
	/** The revision identifier created for the deployment. */
	public readonly revisionId: string;
	/** The revision execution role. Use this to grant the function access to AWS services. */
	public readonly executionRole: Role;
	/** Grant principal for standard CDK grant APIs, e.g. table.grantReadWriteData(fn.grantPrincipal). */
	public get grantPrincipal(): IPrincipal {
		return this.executionRole;
	}
	/** User pool created only when cognito is configured. Retained on stack deletion. */
	public readonly userPool?: UserPool;
	/** Public browser app client created only when cognito is configured. */
	public readonly userPoolClient?: UserPoolClient;
	/** Managed login domain created only when cognito is configured. */
	public readonly userPoolDomain?: UserPoolDomain;
	private readonly constructId: string;
	private readonly revision: CfnWebFunctionRevision;
	private deliveryOwner?: Construct;

	constructor(scope: Construct, id: string, props: WebFunctionProps) {
		super(scope, id);

		this.constructId = id;
		// The actual WebFunction
		const webProps = WebFunctionPropsSchema.parse(props);
		if (webProps.cognito) {
			this.userPool = new UserPool(this, "UserPool", {
				signInAliases: { email: true },
				autoVerify: { email: true },
				selfSignUpEnabled: false,
				accountRecovery: AccountRecovery.EMAIL_ONLY,
				mfa: Mfa.REQUIRED,
				mfaSecondFactor: { sms: false, otp: true },
				passwordPolicy: {
					minLength: 12,
					requireDigits: true,
					requireLowercase: true,
					requireUppercase: true,
					requireSymbols: true,
				},
				featurePlan: FeaturePlan.ESSENTIALS,
				removalPolicy: RemovalPolicy.RETAIN,
			});
			this.userPoolClient = this.userPool.addClient("BrowserClient", {
				generateSecret: false,
				supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
				authFlows: { userSrp: true },
				oAuth: {
					flows: { authorizationCodeGrant: true },
					scopes: [OAuthScope.OPENID, OAuthScope.PROFILE, OAuthScope.EMAIL],
					callbackUrls: webProps.cognito.callbackUrls,
					logoutUrls: webProps.cognito.logoutUrls ?? webProps.cognito.callbackUrls,
				},
				accessTokenValidity: Duration.minutes(10),
				idTokenValidity: Duration.minutes(10),
				refreshTokenValidity: Duration.days(7),
				enableTokenRevocation: true,
				refreshTokenRotationGracePeriod: Duration.seconds(10),
				preventUserExistenceErrors: true,
			});
			this.userPoolDomain = this.userPool.addDomain("LoginDomain", {
				cognitoDomain: { domainPrefix: webProps.cognito.domainPrefix },
				managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
			});
			const branding = new CfnManagedLoginBranding(this, "LoginBranding", {
				userPoolId: this.userPool.userPoolId,
				clientId: this.userPoolClient.userPoolClientId,
				useCognitoProvidedValues: true,
			});
			branding.node.addDependency(this.userPoolDomain);
			webProps.environmentVariables = {
				...webProps.environmentVariables,
				COGNITO_USER_POOL_ID: this.userPool.userPoolId,
				COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
			};
			new CfnOutput(this, "CognitoUserPoolId", {
				value: this.userPool.userPoolId,
			});
			new CfnOutput(this, "CognitoClientId", {
				value: this.userPoolClient.userPoolClientId,
			});
			new CfnOutput(this, "CognitoLoginDomain", {
				value: this.userPoolDomain.baseUrl(),
			});
			new CfnOutput(this, "CognitoIssuer", {
				value: `https://cognito-idp.${this.userPool.stack.region}.${this.userPool.stack.urlSuffix}/${this.userPool.userPoolId}`,
			});
		}
		const webFunction = new CfnWebFunction(this, `${id}-web-function`, {
			functionName: webProps.functionName,
		});

		// Create the immutable code revision before routing traffic to it.
		const { revision, executionRole } = this.uploadToS3(
			webProps,
			webFunction,
		);
		this.revision = revision;
		this.executionRole = executionRole;

		// Route the endpoint to the revision created above, not a guessed revision ID.
		const webFunctionEndpoint = new CfnWebFunctionEndpoint(
			this,
			`${id}-web-function-endpoint`,
			{
				authType: webProps.authType,
				endpointName: webProps.endpointName,
				endpointType: webProps.endpointType,
				functionName: webFunction.webFunctionRef.functionArn,
				description: webProps.description,
				regions: webProps.regions,
				scalingConfig: webProps.scalingConfig,
				throttleConfig: webProps.throttleConfig,
				revisionWeights: [
					{ revisionId: revision.attrRevisionId, weight: 100 },
				],
			},
		);
		webFunctionEndpoint.node.addDependency(revision);

		this.functionArn = webFunction.webFunctionRef.functionArn;
		this.endpointDomainName = webFunctionEndpoint.attrDomainName;
		this.endpointArn = webFunctionEndpoint.attrEndpointArn;
		this.authType = props.authType;
		this.endpointType = props.endpointType;
		this.revisionId = revision.attrRevisionId;

		new CfnOutput(this, "webFunctionUrl", {
			value: this.functionArn,
			exportName: `${id}-webFunctionArn`,
		});

		new CfnOutput(this, "webFunctionEndpointUrl", {
			value: this.endpointDomainName,
			exportName: `${id}-webFunctionDomainName`,
		});
	}

	/**
	 * Throws when a WebFunctionDelivery already owns this Web Function. Does not claim ownership.
	 * @internal
	 */
	public _assertDeliveryAvailable(): void {
		if (this.deliveryOwner) {
			throw new Error(
				`WebFunction ${this.node.path} already has a delivery attached at ${this.deliveryOwner.node.path}`,
			);
		}
	}

	/**
	 * Records the WebFunctionDelivery that owns this Web Function's CloudFront invoke policy.
	 * Also orders the Revision after the delivery's static uploads, so assets are present before
	 * the Revision can be routed. Call only after the owner's constructs are fully created, so a
	 * failed construction leaves no claim.
	 * @internal
	 */
	public _attachDelivery(owner: Construct, staticUploads: Construct[]): void {
		this._assertDeliveryAvailable();
		for (const upload of staticUploads) {
			this.revision.node.addDependency(upload);
		}
		this.deliveryOwner = owner;
	}

	private uploadToS3(
		webProps: ParsedWebFunctionProps,
		webFunction: CfnWebFunction,
	): { revision: CfnWebFunctionRevision; executionRole: Role } {
		const zipFile = webProps.artifact
			? this.zipArtifact(webProps.artifact.directory)
			: this.zipBundle(this.bundleEntry(webProps.entry!));
		const codeBucket = new Bucket(
			this,
			`${this.constructId}-web-function-code-bucket`,
			{
				autoDeleteObjects: true,
				blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
				encryption: BucketEncryption.S3_MANAGED,
				enforceSSL: true,
				removalPolicy: RemovalPolicy.DESTROY,
				versioned: true,
			},
		);
		const codeDeployment = new BucketDeployment(
			this,
			`${this.constructId}-web-function-code-deployment`,
			{
				sources: [Source.asset(zipFile)],
				destinationBucket: codeBucket,
				extract: false,
				prune: false,
				retainOnDelete: false,
			},
		);
		const codeKey = Fn.select(0, codeDeployment.objectKeys);
		const bucketReadPolicy = codeBucket.addToResourcePolicy(
			new IamPolicyStatement({
				actions: ["s3:GetObject", "s3:GetObjectVersion"],
				effect: Effect.ALLOW,
				principals: [new ServicePrincipal("lambda.amazonaws.com")],
				resources: [codeBucket.arnForObjects(codeKey)],
				conditions: {
					StringEquals: { "aws:SourceAccount": codeBucket.stack.account },
				},
			}),
		);
		if (!bucketReadPolicy.statementAdded) {
			throw new Error("Failed to add Lambda WebFunction code bucket policy");
		}
		const iamRole = new Role(
			this,
			`${this.constructId}-web-function-revision-role`,
			{
				assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
			},
		);
		// AWS requires execution-role permissions even for platform init/system logs.
		// LocalStack emits these without enforcing the role, which can hide this gap.
		const logGroup =
			webProps.loggingConfig?.logGroup ?? `/aws/lambda/web/${webProps.functionName}`;
		const logPermissions = iamRole.addToPrincipalPolicy(
			new IamPolicyStatement({
				actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
				resources: [
					logGroup,
					`${logGroup}:*`,
					`${logGroup}.local`,
					`${logGroup}.local:*`,
				].map((name) =>
					codeBucket.stack.formatArn({
						service: "logs",
						resource: "log-group",
						resourceName: name,
						arnFormat: ArnFormat.COLON_RESOURCE_NAME,
					}),
				),
			}),
		);
		const cfnWebFunctionRevision = new CfnWebFunctionRevision(
			this,
			`${this.constructId}-web-function-revision`,
			{
				functionName: webFunction.webFunctionRef.functionArn,
				buildConfig: {
					codeConfig: {
						s3Object: {
							bucket: codeBucket.bucketName,
							key: codeKey,
							versionId: Fn.select(0, codeDeployment.objectVersionIds),
						},
					},
					runtimeConfig: {
						runtime: "nodejs24.x",
					},
				},
				serviceConfig: {
					executionRoleArn: iamRole.roleArn,
					environmentVariables: webProps.artifact
						? { ...webProps.environmentVariables, AWS_LAMBDA_NODEJS_ENTRYPOINT: webProps.artifact.entrypoint }
						: webProps.environmentVariables,
					maxConcurrencyPerEnvironment: webProps.maxConcurrencyPerEnvironment,
					timeoutSeconds: webProps.timeoutSeconds,
					telemetryConfig:
						webProps.loggingConfig !== undefined
							? { loggingConfig: webProps.loggingConfig }
							: undefined,
				},
			},
		);
		cfnWebFunctionRevision.node.addDependency(codeDeployment);
		if (logPermissions.policyDependable) {
			cfnWebFunctionRevision.node.addDependency(logPermissions.policyDependable);
		}
		if (bucketReadPolicy.policyDependable !== undefined) {
			cfnWebFunctionRevision.node.addDependency(
				bucketReadPolicy.policyDependable,
			);
		}
		return { revision: cfnWebFunctionRevision, executionRole: iamRole };
	}
	private bundleEntry(entry: string): string {
		const bundleDirectory = path.join(
			webFunctionArchiveDirectory,
			this.node.addr,
		);
		mkdirSync(bundleDirectory, { recursive: true });
		const bundleFile = path.join(bundleDirectory, "index.js");
		rmSync(bundleFile, { force: true });
		try {
			execFileSync("bun", [
				"build",
				path.resolve(entry),
				"--target=node",
				"--outfile",
				bundleFile,
			]);
		} catch (err) {
			throw new Error(`Failed to bundle entry "${entry}" for Node.js`, {
				cause: err,
			});
		}
		return bundleFile;
	}
	private zipArtifact(directory: string): string {
		return zipArtifactDirectory(
			directory,
			path.join(webFunctionArchiveDirectory, `${this.node.addr}.zip`),
		);
	}
	private zipBundle(bundleFile: string): string {
		const outputZip = path.join(
			webFunctionArchiveDirectory,
			`${this.node.addr}.zip`,
		);
		rmSync(outputZip, { force: true });
		try {
			execFileSync("zip", ["-q", outputZip, path.basename(bundleFile)], {
				cwd: path.dirname(bundleFile),
			});
		} catch (err) {
			throw new Error(`Failed to zip bundle "${bundleFile}"`, { cause: err });
		}
		return outputZip;
	}
}
