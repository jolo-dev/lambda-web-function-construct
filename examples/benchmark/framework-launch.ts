import {createHash,randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import path from "node:path";
import {parseArgs} from "node:util";
import {FRAMEWORKS} from "./framework";
import {stableJson} from "./oha";
import {executeAwsJson} from "./framework-process";
import {deliveryCommands} from "./framework-bootstrap";
const args=parseArgs({options:{profile:{type:"string"},region:{type:"string"}}}).values;
if(!args.profile||args.region!=="eu-central-1")throw Error("Supply --profile and --region eu-central-1 explicitly");
// Per-process assertion only: no persistent power-management preferences are changed.
const sleepInhibitor=process.platform==="darwin"?Bun.spawn(["/usr/bin/caffeinate","-i","-w",String(process.pid)],{stdout:"ignore",stderr:"ignore"}):null;
if(sleepInhibitor){await Bun.sleep(250);if(sleepInhibitor.exitCode!==null)throw Error("Could not establish the local idle-sleep inhibitor");}
const base=import.meta.dir,startedAt=new Date().toISOString(),id=startedAt.replace(/[:.]/g,"-");
const directory=path.join(base,"results",`framework-${id}`),input=path.join(directory,"input");mkdirSync(path.join(input,"fixtures"),{recursive:true});
const environment:any={...process.env,AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:"true",AWS_REGION:args.region,AWS_PAGER:""};
for(const key of Object.keys(environment))if(key.startsWith("AWS_ENDPOINT_URL"))delete environment[key];
function run(command:string,parameters:string[],timeout=120000){return execFileSync(command,parameters,{encoding:"utf8",env:environment,timeout,maxBuffer:32*1024*1024});}
function aws(service:string,operation:string,...parameters:string[]):any{return executeAwsJson(()=>run("aws",[service,operation,...parameters,"--profile",args.profile!,"--region",args.region!,"--output","json","--no-cli-pager"]),`${service}:${operation}`,parameters[parameters.indexOf("--instance-ids")+1]);}
function save(name:string,data:any){writeFileSync(path.join(directory,name),JSON.stringify(data,null,2)+"\n");}
function webState(account:string){return Object.fromEntries(FRAMEWORKS.map(server=>{const arn=`arn:aws:lambda:${args.region}:${account}:web-function/bench-${server}`;
 const read=(type:string,identifier:string)=>JSON.parse(aws("cloudcontrol","get-resource","--type-name",type,"--identifier",identifier).ResourceDescription.Properties);
 const endpoint=read("AWS::Lambda::WebFunctionEndpoint",`${arn}/endpoint/prod`);
 const revisions=endpoint.RevisionWeights.map((r:any)=>read("AWS::Lambda::WebFunctionRevision",`${arn}/revision/${r.RevisionId}`));
 return [server,{endpoint,revisions}];}));}
function comparable(state:any){return Object.fromEntries(Object.entries(state).map(([server,v]:[string,any])=>[server,{weights:v.endpoint.RevisionWeights,scaling:v.endpoint.ScalingConfig,throttle:v.endpoint.ThrottleConfig,auth:v.endpoint.AuthType,revisions:v.revisions.map((r:any)=>({id:r.RevisionId,service:r.ServiceConfig,build:r.BuildConfig}))}]));}
const identity=aws("sts","get-caller-identity");environment.CDK_DEFAULT_ACCOUNT=identity.Account;environment.CDK_DEFAULT_REGION=args.region;
const before=webState(identity.Account);save("configuration-before.json",before);
for(const [server,value] of Object.entries(before) as [string,any][]){const response=await fetch(`https://${value.endpoint.DomainName}/ping`,{signal:AbortSignal.timeout(15000)});const body=await response.json();if(response.status!==200||body.ok!==true||body.server!==server)throw Error(`Deployed preflight failed before provisioning: ${server}`);}
const priceFilters=Object.entries({instanceType:"c7g.xlarge",location:"EU (Frankfurt)",operatingSystem:"Linux",tenancy:"Shared",preInstalledSw:"NA",capacitystatus:"Used"}).map(([Field,Value])=>({Type:"TERM_MATCH",Field,Value}));
save("runner-price-products.json",JSON.parse(run("aws",["pricing","get-products","--service-code","AmazonEC2","--region","us-east-1","--profile",args.profile!,"--filters",JSON.stringify(priceFilters),"--output","json","--no-cli-pager"])));
const vpc=aws("ec2","describe-vpcs","--filters","Name=is-default,Values=true").Vpcs[0];if(!vpc)throw Error("Default VPC not found");
const subnet=aws("ec2","describe-subnets","--filters",`Name=vpc-id,Values=${vpc.VpcId}`).Subnets.find((s:any)=>s.MapPublicIpOnLaunch);if(!subnet)throw Error("Public default subnet not found");
const cdkArgs=["--profile",args.profile!,"--app","bun run examples/benchmark/framework-cdk.ts","--context",`vpcId=${vpc.VpcId}`,"--context",`subnetId=${subnet.SubnetId}`,"--output",path.join(directory,"cdk.out")];
let launched=false,instanceId="",bucket="",commandId="",downloaded=false,manifest:any=null;
const recovery:any={localIdleSleepInhibitorPid:sleepInhibitor?.pid,profile:args.profile,region:args.region,account:identity.Account,stackName:"FrameworkBenchmarkRunner",vpcId:vpc.VpcId,subnetId:subnet.SubnetId,directory,startedAt};
try{aws("cloudformation","describe-stacks","--stack-name","FrameworkBenchmarkRunner");throw Error("Runner stack already exists; refusing to replace or delete it");}catch(error:any){if(!String(error.stderr).includes("does not exist"))throw error;}
const quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
try{
 run("bunx",["cdk","synth","FrameworkBenchmarkRunner",...cdkArgs]);
 save("cdk-diff.txt",{text:run("bunx",["cdk","diff","FrameworkBenchmarkRunner",...cdkArgs,"--no-change-set"])});
 launched=true;run("bunx",["cdk","deploy","FrameworkBenchmarkRunner",...cdkArgs,"--require-approval","never","--outputs-file",path.join(directory,"infra-outputs.json")],900000);
 const outputs=JSON.parse(readFileSync(path.join(directory,"infra-outputs.json"),"utf8")).FrameworkBenchmarkRunner;instanceId=outputs.InstanceId;bucket=outputs.BucketName;
 Object.assign(recovery,{instanceId,bucket});save("recovery.json",recovery);
 console.log(`Temporary runner ${instanceId}; artifacts ${bucket}`);
 const nodeChecksums=run("curl",["-fsSL","https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"]);
 const nodeLine=nodeChecksums.split("\n").find(line=>/node-v24\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz$/.test(line));if(!nodeLine)throw Error("Cannot verify official Node 24 ARM artifact");
 const [nodeSha,nodeArchive]=nodeLine.trim().split(/\s+/);const nodeVersion=nodeArchive.split("-linux")[0].replace("node-","");
 const release=async(url:string)=>{const response=await fetch(url);if(!response.ok)throw Error(`Release lookup ${response.status}`);return await response.json();};
 const ohaRelease=await release("https://api.github.com/repos/hatoo/oha/releases/tags/v1.16.0"),bunRelease=await release("https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4");
 const oha=ohaRelease.assets.find((a:any)=>a.name==="oha-linux-arm64"),bun=bunRelease.assets.find((a:any)=>a.name==="bun-linux-aarch64.zip");
 if(!oha?.digest?.startsWith("sha256:")||!bun?.digest?.startsWith("sha256:"))throw Error("Official release SHA-256 digests missing");
 const artifacts={node:{url:`https://nodejs.org/dist/${nodeVersion}/${nodeArchive}`,sha256:nodeSha},oha:{url:oha.browser_download_url,sha256:oha.digest.slice(7)},bun:{url:bun.browser_download_url,sha256:bun.digest.slice(7)}};
 const hashes:Record<string,string>={};
 for(const server of FRAMEWORKS){const output=path.join(input,"fixtures",`${server}.mjs`);run("bun",["build",path.join(base,"framework-fixtures",`${server}.ts`),"--target=node","--format=esm","--outfile",output]);hashes[server]=createHash("sha256").update(readFileSync(output)).digest("hex");}
 run("bun",["build",path.join(base,"framework-worker.ts"),"--target=bun","--format=esm","--outfile",path.join(input,"worker.mjs")]);
 const versions=Object.fromEntries(["express","hono","@hono/node-server","h3"].map(name=>[name,JSON.parse(readFileSync(path.join(process.cwd(),"node_modules",name,"package.json"),"utf8")).version]));
 const config={schemaVersion:1,startedAt,profile:args.profile,region:args.region,identity,instanceId,bucket,seed:randomBytes(4).readUInt32LE(),durationSeconds:30,warmupSeconds:15,repeats:5,
 endpoints:Object.fromEntries(Object.entries(before).map(([server,v]:[string,any])=>[server,`https://${v.endpoint.DomainName}`])),versions,artifacts,fixtureSha256:hashes,
 methodology:{controlled:"Identical minimal payload, separate pinned CPU sets; native HTTP localhost, no TLS; server CPU deltas only",deployed:"Existing application /ping over HTTPS; 1000 RPS ceiling with latency correction, not maximum capacity; no single-environment CPU attribution"}};
 writeFileSync(path.join(input,"config.json"),JSON.stringify(config,null,2)+"\n");save("run-config.json",config);
 const root="/opt/framework-bench";
 const downloads=Object.entries(artifacts).map(([name,a])=>`curl --fail --location --retry 3 ${quote(a.url)} -o ${name}.download\necho ${quote(a.sha256+"  "+name+".download")} | sha256sum --check -`);
 const bootstrap=`#!/bin/bash\nset -euo pipefail\ncd ${root}\ndnf install -y unzip xz util-linux\ncommand -v curl >/dev/null || dnf install -y curl-minimal\n${downloads.join("\n")}\nmkdir node\ntar -xJf node.download -C node --strip-components=1\nunzip -q bun.download\nmv bun-linux-aarch64/bun ./bun\nmv oha.download ./oha\nchmod +x bun oha\n./node/bin/node --version\n./bun --version\n./oha --version\necho ready | aws s3 cp - s3://${bucket}/output/ready.txt --region ${args.region} --only-show-errors\n./bun worker.mjs 2>&1 | tee worker.log\n`;
 writeFileSync(path.join(input,"bootstrap.sh"),bootstrap);
 const archive=path.join(directory,"input.tar.gz");run("tar",["-czf",archive,"-C",input,"."]);
 run("aws",["s3","cp",archive,`s3://${bucket}/input/package.tar.gz`,"--profile",args.profile!,"--region",args.region!,"--only-show-errors"]);
 for(let attempt=0;attempt<60;attempt++){const info=aws("ssm","describe-instance-information","--filters",JSON.stringify([{Key:"InstanceIds",Values:[instanceId]}])).InstanceInformationList;if(info.some((i:any)=>i.PingStatus==="Online"))break;if(attempt===59)throw Error("Runner did not become SSM Online");await Bun.sleep(10000);}
 const commands=deliveryCommands(bucket,args.region!);
 commandId=aws("ssm","send-command","--document-name","AWS-RunShellScript","--instance-ids",instanceId,"--timeout-seconds","600","--parameters",JSON.stringify({commands:[commands],executionTimeout:["6600"]})).Command.CommandId;
 recovery.commandId=commandId;save("recovery.json",recovery);console.log(`SSM command ${commandId}; measurements running (about 90 minutes)`);
 let invocation:any;
 for(let attempt=0;attempt<230;attempt++){
  await Bun.sleep(30000);invocation=aws("ssm","get-command-invocation","--command-id",commandId,"--instance-id",instanceId);save("ssm-invocation.json",invocation);
  if(attempt%4===0)console.log(`${new Date().toISOString()} SSM ${invocation.Status}`);
  if(!["Pending","InProgress","Delayed"].includes(invocation.Status))break;
 }
 run("aws",["s3","cp",`s3://${bucket}/output/results.tar.gz`,path.join(directory,"results.tar.gz"),"--profile",args.profile!,"--region",args.region!,"--only-show-errors"]);downloaded=true;
 mkdirSync(path.join(directory,"raw"),{recursive:true});run("tar",["-xzf",path.join(directory,"results.tar.gz"),"-C",path.join(directory,"raw")]);
 manifest=JSON.parse(readFileSync(path.join(directory,"raw/manifest.json"),"utf8"));
 manifest.remoteStatus=invocation.Status;
 if(invocation.Status!=="Success"||manifest.status!=="complete"){manifest.status="failed";manifest.error=manifest.error??`SSM ${invocation.Status}; retrieved a partial checkpoint`;}
 save("manifest.json",manifest);
 writeFileSync(path.join(base,"results/framework-latest.json"),JSON.stringify({...manifest,directory:path.relative(base,directory)},null,2)+"\n");
 const after=webState(identity.Account);save("configuration-after.json",after);recovery.configurationUnchanged=stableJson(comparable(before))===stableJson(comparable(after));
 if(manifest.deployedStartedAt){await Bun.sleep(65000);const start=new Date(Math.floor(Date.parse(manifest.deployedStartedAt)/60000)*60000).toISOString(),end=new Date(Math.ceil(Date.parse(manifest.deployedEndedAt??manifest.finishedAt)/60000)*60000).toISOString();
  const diagnostics:any={start,end,scope:"Whole-function minute buckets across deployed phase, including warmups/idle and possible unrelated traffic; not per-cell CPU",metrics:{}};
  for(const server of FRAMEWORKS)for(const metric of ["EnvironmentCPUTime","ExecutedRequests"]){const dimensions=[{Name:"FunctionName",Value:`bench-${server}`},...(metric==="ExecutedRequests"?[{Name:"EndpointName",Value:"prod"}]:[])];diagnostics.metrics[`${server}:${metric}`]=aws("cloudwatch","get-metric-statistics","--namespace","AWS/Lambda/Web","--metric-name",metric,"--dimensions",JSON.stringify(dimensions),"--start-time",start,"--end-time",end,"--period","60","--statistics","Sum");}
  save("cloudwatch.json",diagnostics);
 }
 if(invocation.Status!=="Success"||manifest.status!=="complete")throw Error(`Remote run ${invocation.Status}; manifest ${manifest.status}: ${manifest.error??""}`);
 if(!recovery.configurationUnchanged)throw Error("Deployed function configuration changed during the run; compare snapshots");
}catch(error){recovery.error=String(error);process.exitCode=1;console.error(error);}
finally{
 recovery.cleanupStartedAt=new Date().toISOString();save("recovery.json",recovery);
 if(instanceId){try{aws("ec2","terminate-instances","--instance-ids",instanceId);run("aws",["ec2","wait","instance-terminated","--instance-ids",instanceId,"--profile",args.profile!,"--region",args.region!],360000);recovery.instanceTerminated=true;}catch(error){recovery.terminationError=String(error);}}
 if(launched&&(!commandId||downloaded)){try{
  const resources=aws("cloudformation","list-stack-resources","--stack-name","FrameworkBenchmarkRunner").StackResourceSummaries;save("temporary-resources.json",resources);
  run("bunx",["cdk","destroy","FrameworkBenchmarkRunner",...cdkArgs,"--force"],900000);recovery.stackDeleted=true;
  for(const resource of resources.filter((r:any)=>r.ResourceType==="AWS::Lambda::Function")){try{aws("logs","delete-log-group","--log-group-name",`/aws/lambda/${resource.PhysicalResourceId}`);}catch(error:any){if(!String(error.stderr).includes("ResourceNotFoundException"))recovery.temporaryLogCleanupError=String(error);}}
  try{aws("cloudformation","describe-stacks","--stack-name","FrameworkBenchmarkRunner");recovery.stackDeletionVerified=false;}catch(error:any){if(String(error.stderr).includes("does not exist"))recovery.stackDeletionVerified=true;else throw error;}
 }catch(error){recovery.stackDeleteError=String(error);process.exitCode=1;}}
 else if(launched){recovery.stackRetainedReason="Result retrieval failed; preserve the artifact bucket for recovery. Instance termination was still attempted.";process.exitCode=1;}
 recovery.downloaded=downloaded;recovery.finishedAt=new Date().toISOString();save("recovery.json",recovery);sleepInhibitor?.kill();console.log(`Artifacts: ${directory}; cleanup: ${JSON.stringify(recovery)}`);
}
