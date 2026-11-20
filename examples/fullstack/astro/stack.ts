import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AstroWebFunction, WebFunction, WebFunctionDelivery } from "../../../src";

export interface AstroExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; it must contain index.js and dist/client/_astro. */
  readonly artifactDirectory: string;
}

/**
 * Astro (SSR, `@astrojs/node` mode "local") on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * No live deployment: only the TanStack Start example has a retained deployment (see `examples/fullstack/shared/live-resources.md`).
 */
export class AstroExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: AstroExampleStackProps) {
    super(scope, id, props);
    const site = new AstroWebFunction(this, "App", {
      artifactDirectory: props.artifactDirectory,
      functionName: "fullstack-astro",
      // Spec §5.7: explicit DESTROY pass-through — matches the other examples
      // and avoids the construct's RETAIN default orphaning the asset bucket.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.webFunction = site.webFunction;
    this.delivery = site.delivery;
  }
}
