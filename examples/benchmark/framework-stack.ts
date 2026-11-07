import { CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
export interface FrameworkStackProps extends StackProps { vpcId:string;subnetId:string }
export class FrameworkBenchmarkStack extends Stack {
	constructor(scope:Construct,id:string,props:FrameworkStackProps) {
		super(scope,id,props);
		Tags.of(this).add("Purpose","temporary-framework-benchmark");
		const bucket=new s3.Bucket(this,"Artifacts",{encryption:s3.BucketEncryption.KMS_MANAGED,blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,removalPolicy:RemovalPolicy.DESTROY,autoDeleteObjects:true,lifecycleRules:[{expiration:Duration.days(2)}]});
		const role=new iam.Role(this,"RunnerRole",{assumedBy:new iam.ServicePrincipal("ec2.amazonaws.com"),managedPolicies:[iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")]});
		bucket.grantRead(role,"input/*");bucket.grantPut(role,"output/*");
		const profile=new iam.CfnInstanceProfile(this,"RunnerProfile",{roles:[role.roleName]});
		const group=new ec2.CfnSecurityGroup(this,"RunnerSecurityGroup",{vpcId:props.vpcId,groupDescription:"No inbound access; HTTPS egress for SSM and benchmark downloads",securityGroupEgress:[{ipProtocol:"tcp",fromPort:443,toPort:443,cidrIp:"0.0.0.0/0"}]});
		const instance=new ec2.CfnInstance(this,"Runner",{instanceType:"c7g.xlarge",imageId:new CfnParameter(this,"RunnerAmi",{type:"AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>",default:"/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"}).valueAsString,iamInstanceProfile:profile.ref,
			metadataOptions:{httpTokens:"required",httpPutResponseHopLimit:1},instanceInitiatedShutdownBehavior:"terminate",
			networkInterfaces:[{deviceIndex:"0",associatePublicIpAddress:true,subnetId:props.subnetId,groupSet:[group.attrGroupId]}],
			blockDeviceMappings:[{deviceName:"/dev/xvda",ebs:{volumeSize:16,volumeType:"gp3",encrypted:true,deleteOnTermination:true}}],
			userData:{"Fn::Base64":"#!/bin/bash\nset -euo pipefail\nshutdown -h +115\nsystemctl enable --now amazon-ssm-agent\n"}});
		instance.node.addDependency(role);
		new CfnOutput(this,"InstanceId",{value:instance.ref});new CfnOutput(this,"BucketName",{value:bucket.bucketName});
	}
}
