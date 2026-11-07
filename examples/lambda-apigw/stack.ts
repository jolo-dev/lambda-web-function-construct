import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
	Architecture,
	Code,
	Function as LambdaFunction,
	Runtime,
} from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

const bundleWorkspace = mkdtempSync(
	path.join(tmpdir(), "pawl-lambda-apigw-"),
);
process.on("exit", () => {
	rmSync(bundleWorkspace, { recursive: true, force: true });
});

export class LambdaApiGwStack extends Stack {
	public readonly lambdaFunction: LambdaFunction;
	public readonly httpApi: HttpApi;
	public readonly apiEndpoint: string;

	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		const outDir = path.join(bundleWorkspace, this.node.addr);
		mkdirSync(outDir, { recursive: true });
		const entryFile = path.join(__dirname, "index.ts");
		const bundleFile = path.join(outDir, "index.js");

		execFileSync("bun", [
			"build",
			entryFile,
			"--target=node",
			"--format=cjs",
			"--outfile",
			bundleFile,
		]);

		this.lambdaFunction = new LambdaFunction(this, "ClassicEventLambda", {
			functionName: "bench-lambda-apigw",
			runtime: Runtime.NODEJS_24_X,
			architecture: Architecture.ARM_64,
			handler: "index.handler",
			code: Code.fromAsset(outDir),
			memorySize: 2048,
			timeout: Duration.seconds(30),
		});

		this.httpApi = new HttpApi(this, "ClassicHttpApi", {
			apiName: "bench-lambda-apigw-http-api",
			defaultIntegration: new HttpLambdaIntegration(
				"DefaultLambdaIntegration",
				this.lambdaFunction,
			),
		});

		this.apiEndpoint = this.httpApi.apiEndpoint;

		new CfnOutput(this, "lambdaApiGwUrl", {
			value: this.apiEndpoint,
			exportName: `${id}-lambdaApiGwUrl`,
		});
	}
}
