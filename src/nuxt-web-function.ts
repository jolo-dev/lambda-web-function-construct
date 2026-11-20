import { Construct } from "constructs";
import {
	FrameworkWebFunctionBase,
	NUXT_FRAMEWORK,
	type FrameworkWebFunctionProps,
} from "./framework-web-function";

/**
 * Deploys a prebuilt Nuxt (Nitro node-server) artifact as a Lambda Web Function
 * with a CloudFront delivery. The launcher is `index.js` at the artifact root and
 * the content-hashed assets under `.output/public/_nuxt/` are served from private
 * S3 under `/_nuxt/`.
 *
 * ```ts
 * new NuxtWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/nuxt/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: [
 *     { actions: "dynamodb:GetItem", resources: [table.tableArn] },
 *     { actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.bucketArn] },
 *   ],
 * });
 * ```
 */
export class NuxtWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, NUXT_FRAMEWORK);
	}
}
