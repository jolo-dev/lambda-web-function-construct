import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { readSessionPassword } from "../shared/session-secret";
import { TanStackWebFunction, WebFunction, WebFunctionDelivery } from "../../../src";

export interface TanStackStartExampleStackProps extends StackProps {
  /** Artifact root staged by build-artifact.mjs; must contain index.js and dist/. */
  readonly artifactDirectory: string;
  /** Secret used by TanStack Start's session cookie signing; must be at least 32 characters. */
  readonly sessionPassword: string;
}

/**
 * TanStack Start on a Web Function with hashed client assets served from private S3.
 * Thin composition only: the framework build is explicit (build:artifact) and never run during synthesis.
 * Bounded live deployment of this stack exists and is intentionally retained (no cleanup); see `examples/fullstack/shared/live-resources.md`.
 */
export class TanStackStartExampleStack extends Stack {
  public readonly webFunction: WebFunction;
  public readonly delivery: WebFunctionDelivery;

  constructor(scope: Construct, id: string, props: TanStackStartExampleStackProps) {
    super(scope, id, props);

    const sessionPassword = readSessionPassword(props.sessionPassword);

    const site = new TanStackWebFunction(this, "App", {
      artifactDirectory: props.artifactDirectory,
      functionName: "fullstack-tanstack-start",
      environmentVariables: { SESSION_PASSWORD: sessionPassword },
      // Spec §5.7: explicit DESTROY pass-through — the asset bucket backs the
      // intentionally retained live deployment, and the construct's RETAIN
      // default would orphan it on delete.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.webFunction = site.webFunction;
    this.delivery = site.delivery;
  }
}
