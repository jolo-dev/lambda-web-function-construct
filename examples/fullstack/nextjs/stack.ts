import path from "node:path";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionDelivery,
  WebFunctionEndpointType,
} from "../../../src";

export interface NextjsExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; it must contain index.js and .next/static. */
  readonly artifactDirectory: string;
}

/**
 * Next.js on a Web Function with hashed chunks served from private S3. Thin composition only: the framework build is
 * explicit (build:artifact) and is never run during synthesis. Not deployed by this change.
 */
export class NextjsExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: NextjsExampleStackProps) {
    super(scope, id, props);
    this.webFunction = new WebFunction(this, "App", {
      artifact: { directory: props.artifactDirectory, entrypoint: "index.js" },
      functionName: "fullstack-nextjs",
      authType: WebFunctionAuthType.IAM_AUTH,
      endpointType: WebFunctionEndpointType.HOME_REGION,
      endpointName: "prod",
    });
    this.delivery = new WebFunctionDelivery(this, "Delivery", {
      webFunction: this.webFunction,
      staticAssets: [
        { directory: path.join(props.artifactDirectory, ".next", "static"), urlPrefix: "/_next/static/" },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
