import { Construct } from "constructs";
import {
	ASTRO_FRAMEWORK,
	FrameworkWebFunctionBase,
	type FrameworkWebFunctionProps,
} from "./framework-web-function";

/**
 * Deploys a prebuilt Astro (SSR, `@astrojs/node`) artifact as a Lambda Web
 * Function with a CloudFront delivery. The launcher is `index.js` at the artifact
 * root and the content-hashed assets under `dist/client/_astro/` are served from
 * private S3 under `/_astro/`.
 *
 * ```ts
 * new AstroWebFunction(this, "Site", {
 *   artifactDirectory: "examples/fullstack/artifacts/astro/native-darwin-arm64",
 *   functionName: "my-site",
 *   permissions: [
 *     { actions: "dynamodb:GetItem", resources: [table.tableArn] },
 *     { actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.bucketArn] },
 *   ],
 * });
 * ```
 */
export class AstroWebFunction extends FrameworkWebFunctionBase {
	constructor(scope: Construct, id: string, props: FrameworkWebFunctionProps) {
		super(scope, id, props, ASTRO_FRAMEWORK);
	}
}
