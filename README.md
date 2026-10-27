# Lambda Web Function Construct

An AWS CDK construct for deploying a Node.js Lambda Web Function with a private code bucket, immutable revision, and HTTPS endpoint.

## Prerequisites

- Node.js 24 or later
- Bun on the machine running CDK synthesis, because the construct bundles the entry file with `bun build`
- AWS CDK v2

## Install

```sh
bun add lambda-web-function-construct aws-cdk-lib constructs
```

## Usage

```ts
import { App, Stack } from "aws-cdk-lib";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionEndpointType,
} from "lambda-web-function-construct";

const app = new App();
const stack = new Stack(app, "WebFunctionStack");

new WebFunction(stack, "WebFunction", {
  entry: "src/http.ts",
  functionName: "my-web-function",
  authType: WebFunctionAuthType.APPLICATION_MANAGED,
  endpointType: WebFunctionEndpointType.HOME_REGION,
  endpointName: "prod",
});

app.synth();
```

`WebFunctionAuthType` and `WebFunctionEndpointType` are typed classes with named constants, not TypeScript enums. They provide editor autocompletion and compile-time type checking while remaining JSII-compatible. Zod validates the underlying values and the supplied option instances during construct creation; plain strings are not accepted.

The entry point is bundled with Bun for Node.js and deployed as a Node.js 24 Lambda Web Function revision. The construct creates the private S3 code bucket, grants the Lambda service read access to the versioned ZIP, and routes the endpoint to the generated revision.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then use the pinned Node.js 24.22.1 and Bun 1.4.4 toolchain:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build
mise exec -- bun test
```

With mise activated in your shell, you can also run the Bun commands directly. Consumers require Node.js 24 or later; the mise pins select reproducible development versions.

CDK library, JSII, and JSII packaging versions are managed by `package.json` and `bun.lock`, not mise. The JSII tools use exact development dependency versions. The CDK CLI is not required or installed.

`bun run build` invokes the local JSII compiler and emits the `.jsii` assembly used by Construct Hub to generate language-aware API documentation.

## License

This library is licensed under the MIT License. See [LICENSE](LICENSE).
