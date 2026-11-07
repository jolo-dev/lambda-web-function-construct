import path from "node:path";
import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
	WebFunction,
	WebFunctionAuthType,
	WebFunctionEndpointType,
} from "../../src";

export class H3WebFunctionStack extends Stack {
	public readonly webFunction: WebFunction;

	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		this.webFunction = new WebFunction(this, "H3WebFunction", {
			entry: path.join(__dirname, "index.ts"),
			functionName: "bench-h3",
			endpointName: "prod",
			authType: WebFunctionAuthType.APPLICATION_MANAGED,
			endpointType: WebFunctionEndpointType.HOME_REGION,
			maxConcurrencyPerEnvironment: 64,
			timeoutSeconds: 30,
		});
	}
}
