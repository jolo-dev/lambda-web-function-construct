import path from "node:path";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionDelivery,
  WebFunctionEndpointType,
} from "../../../src";

export interface NuxtExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; it must contain index.js and .output/public. */
  readonly artifactDirectory: string;
}

/**
 * Nuxt 4 (Nitro node-server) on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * Not deployed by this change.
 */
export class NuxtExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: NuxtExampleStackProps) {
    super(scope, id, props);
    this.webFunction = new WebFunction(this, "App", {
      artifact: { directory: props.artifactDirectory, entrypoint: "index.js" },
      functionName: "fullstack-nuxt",
      authType: WebFunctionAuthType.IAM_AUTH,
      endpointType: WebFunctionEndpointType.HOME_REGION,
      endpointName: "prod",
    });
    // Map only the proven content-hashed public subdirectory (_nuxt) to S3; mutable/unhashed paths stay dynamic.
    this.delivery = new WebFunctionDelivery(this, "Delivery", {
      webFunction: this.webFunction,
      staticAssets: [
        {
          directory: path.join(props.artifactDirectory, ".output", "public", "_nuxt"),
          urlPrefix: "/_nuxt/",
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
