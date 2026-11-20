import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { NuxtWebFunction, WebFunction, WebFunctionDelivery } from "../../../src";

export interface NuxtExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; it must contain index.js and .output/public. */
  readonly artifactDirectory: string;
}

/**
 * Nuxt 4 (Nitro node-server) on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * No live deployment: only the TanStack Start example has a retained deployment (see `examples/fullstack/shared/live-resources.md`).
 */
export class NuxtExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: NuxtExampleStackProps) {
    super(scope, id, props);
    const site = new NuxtWebFunction(this, "App", {
      artifactDirectory: props.artifactDirectory,
      functionName: "fullstack-nuxt",
      // Spec §5.7: explicit DESTROY pass-through — matches the previous
      // hand-assembled delivery and avoids the construct's RETAIN default.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.webFunction = site.webFunction;
    this.delivery = site.delivery;
  }
}
