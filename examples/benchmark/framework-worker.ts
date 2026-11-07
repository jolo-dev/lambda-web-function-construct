import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {lookup} from "node:dns/promises";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomizedBlocks,cpuPerRequest,frameworkOhaArgs,FRAMEWORKS} from "./framework";
import {parseOhaResult} from "./oha";

const root=process.env.BENCH_ROOT??"/opt/framework-bench";
const config=JSON.parse(readFileSync(path.join(root,"config.json"),"utf8"));
const output=path.join(root,"results");mkdirSync(output,{recursive:true});
const manifest:any={...config,status:"running",workerStartedAt:new Date().toISOString(),host:{platform:os.platform(),architecture:os.arch(),cpus:os.cpus(),release:os.release(),node:execFileSync(path.join(root,"node/bin/node"),["--version"],{encoding:"utf8"}).trim(),bun:Bun.version,oha:execFileSync(path.join(root,"oha"),["--version"],{encoding:"utf8"}).trim()},cells:[],warmups:[],preflights:[]};
function save(name:string,data:any){writeFileSync(path.join(output,name),JSON.stringify(data,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n");}
function checkpoint(upload=false){
	manifest.updatedAt=new Date().toISOString();save("manifest.json",manifest);
	if(upload){execFileSync("tar",["-czf",path.join(root,"results.tar.gz"),"-C",output,"."],{timeout:30000});execFileSync("aws",["s3","cp",path.join(root,"results.tar.gz"),`s3://${config.bucket}/output/results.tar.gz`,"--region",config.region,"--only-show-errors"],{timeout:60000});}
}
async function json(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(10000)});if(response.status!==200)throw Error(`Preflight ${url}: ${response.status}`);return {body:await response.json(),headers:Object.fromEntries(response.headers)};}
async function start(server:string,stem:string){
	const child=Bun.spawn(["taskset","-c","3",path.join(root,"node/bin/node"),path.join(root,`fixtures/${server}.mjs`)],{env:{...process.env,PORT:"4500"},stdout:Bun.file(path.join(output,`${stem}-server.stdout`)),stderr:Bun.file(path.join(output,`${stem}-server.stderr`))});
	try{for(let attempt=0;attempt<100;attempt++){
		if(child.exitCode!==null)throw Error(`Server exited: ${server}`);
		try{const telemetry=await json("http://127.0.0.1:4500/__telemetry");if(telemetry.body.pid===child.pid&&telemetry.body.server===server)return child;}catch{}
		await Bun.sleep(100);
	}throw Error(`Server readiness failed: ${server}`);}catch(error){child.kill();await child.exited;throw error;}
}
async function stop(child:any){if(!child)return;child.kill();await Promise.race([child.exited,Bun.sleep(3000)]);if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
async function load(phase:string,cell:any,seconds:number,kind:string){
	const url=phase==="controlled"?"http://127.0.0.1:4500/ping":config.endpoints[cell.server]+"/ping";
	const hostname=new URL(url).hostname;
	const addresses=phase==="deployed"?[...new Set((await lookup(hostname,{family:4,all:true})).map(v=>v.address))]:undefined;
	const stem=`${phase}-${cell.server}-c${cell.concurrency}-r${cell.repeat}-${kind}`;
	const command=["taskset","-c","0,1,2",path.join(root,"oha"),...frameworkOhaArgs(url,cell.concurrency,seconds,phase,addresses)];
	const startedAt=new Date().toISOString();
	const child=Bun.spawn(command,{stdout:"pipe",stderr:"pipe"});
	const [raw,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
	writeFileSync(path.join(output,stem+".json"),raw);writeFileSync(path.join(output,stem+".stderr"),stderr);
	if(exit!==0)throw Error(`oha exit ${exit}: ${stem}: ${stderr}`);
	const parsed=parseOhaResult(JSON.parse(raw)),usage=child.resourceUsage();
	const cpuTimeUs={user:Number(usage.cpuTime.user),system:Number(usage.cpuTime.system),total:Number(usage.cpuTime.total)};
	return {...cell,phase,kind,startedAt,endedAt:new Date().toISOString(),...parsed,command,addresses,rawFile:stem+".json",rawSha256:createHash("sha256").update(raw).digest("hex"),generator:{cpuTimeUs,maxRssBytes:usage.maxRSS},generatorCpuFraction:cpuTimeUs.total/1_000_000/(parsed.totalSeconds*3)};
}
try{
	for(const phase of ["controlled","deployed"]){
		if(phase==="deployed"){
			manifest.deployedStartedAt=new Date().toISOString();checkpoint(true);
			for(const server of FRAMEWORKS){const result=await json(config.endpoints[server]+"/ping");if(result.body.ok!==true||result.body.server!==server)throw Error(`Wrong deployed application: ${server}`);manifest.preflights.push({server,...result});}
		}
		const cases=randomizedBlocks(config.seed+(phase==="deployed"?1:0),config.repeats);
		for(let index=0;index<cases.length;index++){
			const cell=cases[index],stem=`${phase}-${cell.server}-c${cell.concurrency}-r${cell.repeat}`;
			let server:any=null;
			try{
				if(phase==="controlled"){
					server=await start(cell.server,stem);
					const response=await fetch("http://127.0.0.1:4500/ping");if(await response.text()!=='{"ok":true}')throw Error("Unexpected controlled payload");
				}
				manifest.warmups.push(await load(phase,cell,config.warmupSeconds,"warmup"));
				const before=phase==="controlled"?(await json("http://127.0.0.1:4500/__telemetry")).body:null;
				const affinity=server?execFileSync("taskset",["-pc",String(server.pid)],{encoding:"utf8"}).trim():null;
				const result:any=await load(phase,cell,config.durationSeconds,"measured");
				const after=phase==="controlled"?(await json("http://127.0.0.1:4500/__telemetry")).body:null;
				result.cpu=before?cpuPerRequest(before,after,result.successfulRequests):null;
				result.serverBefore=before;result.serverAfter=after;result.serverAffinity=affinity;
				result.validUnconstrainedSample=phase==="controlled"&&result.httpFailures===0&&result.transportErrors===0&&result.generatorCpuFraction<0.85;
				manifest.cells.push(result);
				console.log(`${phase} ${index+1}/${cases.length} ${cell.server} c=${cell.concurrency} r=${cell.repeat}: ${result.successfulRps.toFixed(1)} RPS; errors=${result.httpFailures+result.transportErrors}; CPU ms/1k=${result.cpu?.cpuMsPer1000.toFixed(2)??"not per-process attributable"}`);
			}finally{await stop(server);}
			checkpoint((index+1)%4===0);
		}
		if(phase==="deployed")manifest.deployedEndedAt=new Date().toISOString();
	}
	manifest.status="complete";
}catch(error){manifest.status="failed";manifest.error=String(error);process.exitCode=1;console.error(error);}
finally{manifest.finishedAt=new Date().toISOString();checkpoint(true);console.log(`Saved ${manifest.cells.length} measured cells (${manifest.status})`);}
