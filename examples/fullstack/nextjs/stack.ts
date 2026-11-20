import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { NextJsWebFunction, WebFunction, WebFunctionDelivery } from "../../../src";

export interface NextjsExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; must contain index.js and .next/static. */
  readonly artifactDirectory: string;
}

/**
 * Next.js on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * No live deployment: only the TanStack Start example has a retained deployment (see `examples/fullstack/shared/live-resources.md`).
 */
export class NextjsExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: NextjsExampleStackProps) {
    super(scope, id, props);
    const site = new NextJsWebFunction(this, "App", {
      artifactDirectory: props.artifactDirectory,
      functionName: "fullstack-nextjs",
      // Spec §5.7: explicit DESTROY pass-through — matches the previous
      // hand-assembled delivery and avoids the construct's RETAIN default.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.webFunction = site.webFunction;
    this.delivery = site.delivery;
  }
}
