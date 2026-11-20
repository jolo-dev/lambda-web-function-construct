import { Construct } from "constructs";
import {
	FrameworkWebFunctionBase,
	TANSTACK_FRAMEWORK,
	type FrameworkWebFunctionProps,
} from "./framework-web-function";

/**
 * Deploys a prebuilt TanStack Start artifact as a Lambda Web Function with a
 * CloudFront delivery. The launcher is `index.js` at the artifact root and the
 * content-hashed assets under `dist/client/assets/` are served from private S3
 * under `/assets/`.
 *
 * ```ts
 * new TanStackWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/tanstack-start/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: [
 *     { actions: "dynamodb:GetItem", resources: [table.tableArn] },
 *     { actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.bucketArn] },
 *   ],
 * });
 * ```
 */
export class TanStackWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, TANSTACK_FRAMEWORK);
	}
}
