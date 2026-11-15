import path from "node:path";
import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { WebFunction, WebFunctionAuthType, WebFunctionEndpointType } from "../../src";
import { validateFrontendOrigin } from "./shared/config";

export interface CognitoExampleStackProps extends StackProps {
  readonly framework: "hono" | "express" | "node-http";
  readonly frontendOrigin: string;
  readonly callbackUrls: string[];
  readonly logoutUrls?: string[];
  /** Optional domain prefix; defaults to an account/region/framework-specific name. */
  readonly domainPrefix?: string;
}

export class CognitoExampleStack extends Stack {
  public readonly webFunction: WebFunction;

  constructor(scope: Construct, id: string, props: CognitoExampleStackProps) {
    super(scope, id, props);
    const frontendOrigin = validateFrontendOrigin(props.frontendOrigin);
    this.webFunction = new WebFunction(this, "Api", {
      entry: path.join(__dirname, props.framework, "index.ts"),
      functionName: `cognito-${props.framework}`,
      endpointName: "prod",
      endpointType: WebFunctionEndpointType.HOME_REGION,
      authType: WebFunctionAuthType.APPLICATION_MANAGED,
      maxConcurrencyPerEnvironment: 16,
      timeoutSeconds: 30,
      scalingConfig: { maxEnvironments: 2 },
      throttleConfig: { rateLimit: 50 },
      environmentVariables: { FRONTEND_ORIGIN: frontendOrigin },
      cognito: {
        domainPrefix: props.domainPrefix ?? `webfn-${this.account}-${this.region}-${props.framework}`,
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls ?? [`${frontendOrigin}/`],
      },
    });
  }
}
