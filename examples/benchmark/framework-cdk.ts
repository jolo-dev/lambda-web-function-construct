import { App } from "aws-cdk-lib";
import { FrameworkBenchmarkStack } from "./framework-stack";
const app=new App();
const vpcId=app.node.tryGetContext("vpcId"),subnetId=app.node.tryGetContext("subnetId");
if(!vpcId||!subnetId)throw Error("Supply --context vpcId=... --context subnetId=...");
new FrameworkBenchmarkStack(app,"FrameworkBenchmarkRunner",{env:{account:process.env.CDK_DEFAULT_ACCOUNT,region:process.env.CDK_DEFAULT_REGION},vpcId,subnetId});
app.synth();
