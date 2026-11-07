import { expect, test } from "bun:test";
import { randomizedBlocks, cpuPerRequest, summarizeFramework, frameworkOhaArgs } from "../examples/benchmark/framework";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { FrameworkBenchmarkStack } from "../examples/benchmark/framework-stack";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderFrameworkReport } from "../examples/benchmark/framework-report";
import { executeAwsJson } from "../examples/benchmark/framework-process";
import { execFileSync } from "node:child_process";
import { deliveryCommands } from "../examples/benchmark/framework-bootstrap";

test("SSM acknowledgement survives a local timeout after AWS already returned the command ID", () => {
	const acknowledgement={Command:{CommandId:"9c7361d2-33ed-4ab3-8ff2-c17f828a5b28",InstanceIds:["i-test"]}};
	const invoke=()=>execFileSync("bun",["-e",`console.log(${JSON.stringify(JSON.stringify(acknowledgement))});await Bun.sleep(5000)`],{encoding:"utf8",timeout:150});
	expect(executeAwsJson(invoke,"ssm:send-command","i-test")).toEqual(acknowledgement);
	const failure=()=>{throw Object.assign(new Error("timeout"),{code:"ETIMEDOUT",stdout:JSON.stringify(acknowledgement)});};
	expect(()=>executeAwsJson(failure,"ssm:send-command","i-other")).toThrow();
	expect(()=>executeAwsJson(failure,"ec2:terminate-instances","i-test")).toThrow();
},10000);

test("AL2023 delivery checks its preinstalled AWS CLI instead of guessing a package name", () => {
	const script=deliveryCommands("test-bucket","eu-central-1");
	expect(script).toContain("aws --version");
	expect(script).not.toContain("dnf install");
	expect(script).not.toContain("awscli2");
	expect(script.indexOf("aws --version")).toBeLessThan(script.indexOf("aws s3 cp"));
});

test("randomized blocks are reproducible and contain every candidate/concurrency/repeat exactly once", () => {
	const cases = randomizedBlocks(123,5);
	expect(cases).toHaveLength(60);
	expect(new Set(cases.map(c=>`${c.server}/${c.concurrency}/${c.repeat}`)).size).toBe(60);
	expect(randomizedBlocks(123,5)).toEqual(cases);
	expect(randomizedBlocks(124,5)).not.toEqual(cases);
	for (let index=0;index<cases.length;index+=4) {
		expect(new Set(cases.slice(index,index+4).map(c=>c.server)).size).toBe(4);
		expect(new Set(cases.slice(index,index+4).map(c=>`${c.repeat}/${c.concurrency}`)).size).toBe(1);
	}
});

test("only deployed endpoint traffic is rate capped and latency-corrected", () => {
	const controlled=frameworkOhaArgs("http://127.0.0.1:4500/ping",64,30,"controlled");
	const deployed=frameworkOhaArgs("https://example.com/ping",64,30,"deployed");
	expect(controlled).not.toContain("-q");
	expect(deployed).toContain("1000");expect(deployed).toContain("--latency-correction");
	expect(deployed.at(-1)).toBe("https://example.com/ping");
});

test("CPU efficiency requires the same process, monotonic counters and successful requests", () => {
	const before={pid:10,cpu:{user:1000,system:2000}},after={pid:10,cpu:{user:21000,system:12000}};
	expect(cpuPerRequest(before,after,1000)).toEqual({cpuMs:30,cpuMsPer1000:30});
	expect(cpuPerRequest(before,after,0)).toBeNull();
	expect(()=>cpuPerRequest(before,{...after,pid:11},1000)).toThrow();
	expect(()=>cpuPerRequest(after,before,1000)).toThrow();
});

test("framework summaries never mix bounded AWS load with controlled capacity or average RPS incorrectly", () => {
	const common={server:"express",concurrency:16,repeat:1,totalAttempts:100,httpFailures:0,transportErrors:0,p50Ms:1,p95Ms:2,p99Ms:3};
	const rows = summarizeFramework([
		{...common,phase:"controlled",successfulRequests:100,totalSeconds:1,successfulRps:100,cpu:{cpuMs:10,cpuMsPer1000:100}},
		{...common,repeat:2,phase:"controlled",successfulRequests:100,totalSeconds:3,successfulRps:100/3,cpu:{cpuMs:30,cpuMsPer1000:300}},
		{...common,phase:"deployed",successfulRequests:100,totalSeconds:1,successfulRps:100,cpu:null},
	]);
	expect(rows).toHaveLength(2);
	expect(rows[0].successfulRps).toBe(50);
	expect(rows[0].cpuMsPer1000).toBe(200);
	expect(rows[1].cpuMsPer1000).toBeNull();
});

test("all four Node fixtures return identical minimal payloads and process-specific CPU telemetry", async () => {
	const directory=mkdtempSync(path.join(tmpdir(),"framework-fixtures-"));
	try { for(const name of ["node-http","express","hono","h3"]) {
		const build=await Bun.build({entrypoints:[path.resolve(`examples/benchmark/framework-fixtures/${name}.ts`)],outdir:path.join(directory,name),target:"node",format:"esm",naming:"server.mjs"});
		expect(build.success).toBe(true);
		const child=Bun.spawn(["node",path.join(directory,name,"server.mjs")],{env:{...process.env,PORT:"0"},stdout:"pipe",stderr:"pipe"});
		try {
			const reader=child.stdout.getReader();const first=await reader.read();reader.releaseLock();
			const ready=JSON.parse(new TextDecoder().decode(first.value).trim());
			const response=await fetch(`http://127.0.0.1:${ready.port}/ping`);
			expect(response.status).toBe(200);expect(await response.text()).toBe('{"ok":true}');
			expect(response.headers.get("content-length")).toBe("11");
			expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
			const telemetry=await (await fetch(`http://127.0.0.1:${ready.port}/__telemetry`)).json();
			expect(telemetry.pid).toBe(child.pid);expect(telemetry.server).toBe(name);expect(telemetry.cpu.user).toBeGreaterThanOrEqual(0);
		} finally {child.kill();await child.exited;}
	}} finally {rmSync(directory,{recursive:true,force:true});}
},30000);

test("framework report keeps controlled CPU and capped endpoint latency in separate sections", () => {
	const common={server:"express",concurrency:64,repeat:1,totalAttempts:100,successfulRequests:100,totalSeconds:1,successfulRps:100,httpFailures:0,transportErrors:0,p50Ms:1,p95Ms:2,p99Ms:3,generatorCpuFraction:0.2,validUnconstrainedSample:true};
	const output=renderFrameworkReport({status:"complete",startedAt:"2026-11-03",directory:"results/test",host:{node:"v24",oha:"oha 1.16.0"},cells:[{...common,phase:"controlled",cpu:{cpuMs:10,cpuMsPer1000:100}},{...common,phase:"deployed",cpu:null}],versions:{},repeats:5,durationSeconds:30,warmupSeconds:15});
	expect(output.markdown).toContain("Controlled framework efficiency");
	expect(output.markdown).toContain("not maximum capacity");
	expect(output.markdown).toContain("not per-cell CPU");
	expect(output.markdown).toContain("Corrected latency includes scheduling backlog");
	expect(output.markdown).toContain("not multi-second Lambda response times");
	expect(output.markdown).toContain("Median run corrected p50 ↓ ms");
	expect(output.markdown).toContain("not statistically conclusive");
	expect(output.graphs["controlled-throughput.svg"]).not.toContain("GET /io?delayMs=30");
	expect(output.graphs["controlled-cpu.svg"]).toContain("100.00");
	expect(output.graphs["controlled-cpu.svg"]).toContain("Controlled Node servers");
	expect(output.graphs["controlled-cpu.svg"]).not.toContain("Classic Event Lambda");
});

test("temporary runner has no inbound access, encrypted disposable disk, IMDSv2 and a shutdown backstop", () => {
	const app = new App();
	const stack = new FrameworkBenchmarkStack(app,"RunnerTest",{env:{account:"123456789012",region:"eu-central-1"},vpcId:"vpc-test",subnetId:"subnet-test"});
	const template = Template.fromStack(stack);
	template.hasResourceProperties("AWS::EC2::Instance",{InstanceType:"c7g.xlarge",InstanceInitiatedShutdownBehavior:"terminate",MetadataOptions:{HttpTokens:"required",HttpPutResponseHopLimit:1},BlockDeviceMappings:[{DeviceName:"/dev/xvda",Ebs:{Encrypted:true,DeleteOnTermination:true,VolumeSize:16,VolumeType:"gp3"}}]});
	const groups=Object.values(template.findResources("AWS::EC2::SecurityGroup")) as any[];
	expect(groups.every(g=>!(g.Properties.SecurityGroupIngress?.length))).toBe(true);
	expect(JSON.stringify(template.toJSON())).toContain("shutdown -h +115");
	template.resourceCountIs("AWS::EC2::Instance",1);
	template.resourceCountIs("AWS::S3::Bucket",1);
});
