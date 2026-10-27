import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CfnOutput, Fn, RemovalPolicy } from "aws-cdk-lib";
import {
	Effect,
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

const webFunctionArchiveDirectory = mkdtempSync(
	path.join(tmpdir(), "pawl-web-function-"),
);
process.on("exit", () => {
	rmSync(webFunctionArchiveDirectory, { recursive: true, force: true });
});

/** Properties for configuring a Lambda Web Function and its HTTPS endpoint. */
export interface WebFunctionProps {
	/** Path to the TypeScript or JavaScript HTTP server entry file. */
	readonly entry: string;
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
}

const WebFunctionPropsSchema = z.object({
	entry: z.string().min(1),
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
});

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
export class WebFunction extends Construct {
	private readonly constructId: string;

	constructor(scope: Construct, id: string, props: WebFunctionProps) {
		super(scope, id);

		this.constructId = id;
		// The actual WebFunction
		const webProps = WebFunctionPropsSchema.parse(props);
		const webFunction = new CfnWebFunction(this, `${id}-web-function`, {
			functionName: webProps.functionName,
		});

		// Create the immutable code revision before routing traffic to it.
		const webFunctionRevision = this.uploadToS3(webProps.entry, webFunction);

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
					{ revisionId: webFunctionRevision.attrRevisionId, weight: 100 },
				],
			},
		);
		webFunctionEndpoint.node.addDependency(webFunctionRevision);

		new CfnOutput(this, "webFunctionUrl", {
			value: webFunction.webFunctionRef.functionArn,
			exportName: `${id}-webFunctionArn`,
		});

		new CfnOutput(this, "webFunctionEndpointUrl", {
			value: webFunctionEndpoint.attrDomainName,
			exportName: `${id}-webFunctionDomainName`,
		});
	}

	private uploadToS3(entry: string, webFunction: CfnWebFunction) {
		const bundleFile = this.bundleEntry(entry);
		const zipFile = this.zipBundle(bundleFile);
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
				},
			},
		);
		cfnWebFunctionRevision.node.addDependency(codeDeployment);
		if (bucketReadPolicy.policyDependable !== undefined) {
			cfnWebFunctionRevision.node.addDependency(
				bucketReadPolicy.policyDependable,
			);
		}
		return cfnWebFunctionRevision;
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
