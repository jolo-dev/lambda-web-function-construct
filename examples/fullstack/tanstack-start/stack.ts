import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionDelivery,
  WebFunctionEndpointType,
} from "../../../src";

export interface TanStackStartExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; must contain index.js and dist/. */
  readonly artifactDirectory: string;
}

/**
 * TanStack Start on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * Not deployed by this change.
 */
export class TanStackStartExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: TanStackStartExampleStackProps) {
    super(scope, id, props);

    this.webFunction = new WebFunction(this, "App", {
      artifact: { directory: props.artifactDirectory, entrypoint: "index.js" },
      functionName: "fullstack-tanstack-start",
      authType: WebFunctionAuthType.IAM_AUTH,
      endpointType: WebFunctionEndpointType.HOME_REGION,
      endpointName: "prod",
    });

    this.delivery = new WebFunctionDelivery(this, "Delivery", {
      webFunction: this.webFunction,
      staticAssets: [
        {
          directory: path.join(props.artifactDirectory, "dist", "client", "assets"),
          urlPrefix: "/assets/",
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
