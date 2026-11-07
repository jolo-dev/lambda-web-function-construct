import { App } from "aws-cdk-lib";
import { BunHttpContainerFunctionStack } from "../bun-http/stack";
import { ExpressWebFunctionStack } from "../express/stack";
import { H3WebFunctionStack } from "../h3/stack";
import { HonoWebFunctionStack } from "../hono/stack";
import { LambdaApiGwStack } from "../lambda-apigw/stack";
import { NodeHttpWebFunctionStack } from "../node-http/stack";

const env = {
	account: process.env.CDK_DEFAULT_ACCOUNT || "000000000000",
	region: process.env.CDK_DEFAULT_REGION || "us-east-1",
};

const app = new App();

new NodeHttpWebFunctionStack(app, "NodeHttpStack", { env });
new ExpressWebFunctionStack(app, "ExpressStack", { env });
new HonoWebFunctionStack(app, "HonoStack", { env });
new H3WebFunctionStack(app, "H3Stack", { env });
new BunHttpContainerFunctionStack(app, "BunHttpStack", { env });
new LambdaApiGwStack(app, "LambdaApiGwStack", { env });

app.synth();
