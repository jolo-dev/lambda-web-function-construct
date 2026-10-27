# Lambda Web Function Construct

An AWS CDK construct for deploying a Node.js Lambda Web Function with a private code bucket, immutable revision, and HTTPS endpoint.

## Prerequisites

- Node.js 22 or later
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

The entry point is bundled with Bun for Node.js and deployed as a Node.js 24 Lambda Web Function revision. The construct creates the private S3 code bucket, grants the Lambda service read access to the versioned ZIP, and routes the endpoint to the generated revision.

## Development

```sh
bun install
bun run build
bun test
```

`bun run build` invokes the JSII compiler and emits the `.jsii` assembly used by Construct Hub to generate language-aware API documentation.

## License

This library is licensed under the MIT License. See [LICENSE](LICENSE).
