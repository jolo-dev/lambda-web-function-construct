import { Construct } from "constructs";
import {
	FrameworkWebFunctionBase,
	NEXTJS_FRAMEWORK,
	type FrameworkWebFunctionProps,
} from "./framework-web-function";

/**
 * Deploys a prebuilt Next.js standalone artifact as a Lambda Web Function with a
 * CloudFront delivery. The launcher is `index.js` at the artifact root and the
 * content-hashed assets under `.next/static/` are served from private S3 under
 * `/_next/static/`.
 *
 * ```ts
 * new NextJsWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/nextjs/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: [
 *     { actions: "dynamodb:GetItem", resources: [table.tableArn] },
 *     { actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.bucketArn] },
 *   ],
 * });
 * ```
 */
export class NextJsWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, NEXTJS_FRAMEWORK);
	}
}
