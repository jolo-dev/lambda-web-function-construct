import path from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
	Architecture,
	DockerImageCode,
	DockerImageFunction,
	FunctionUrlAuthType,
} from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

export class BunHttpContainerFunctionStack extends Stack {
	public readonly containerFunction: DockerImageFunction;
	public readonly functionUrl: string;

	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		this.containerFunction = new DockerImageFunction(
			this,
			"BunHttpContainerFunction",
			{
				functionName: "bench-bun-http",
				architecture: Architecture.ARM_64,
				code: DockerImageCode.fromImageAsset(path.join(__dirname, ".."), {
					file: "bun-http/Dockerfile",
				}),
				memorySize: 2048,
				timeout: Duration.seconds(30),
			},
		);

		const fnUrl = this.containerFunction.addFunctionUrl({
			authType: FunctionUrlAuthType.NONE,
		});

		this.functionUrl = fnUrl.url;

		new CfnOutput(this, "bunHttpFunctionUrl", {
			value: this.functionUrl,
			exportName: `${id}-bunHttpFunctionUrl`,
		});
	}
}
