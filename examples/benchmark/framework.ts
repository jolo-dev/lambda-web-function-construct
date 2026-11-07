import { buildOhaArgs, summarizeOhaCells } from "./oha";
export function frameworkOhaArgs(url:string,concurrency:number,seconds:number,phase:string,addresses?:string[]) {
	const args=buildOhaArgs(url,concurrency,seconds,addresses);
	if(phase==="deployed")args.splice(args.length-1,0,"-q","1000","--latency-correction");
	return args;
}
export const FRAMEWORKS = ["node-http","express","hono","h3"] as const;
export function randomizedBlocks(seed:number,repeats=5) {
	let state=seed>>>0;
	const random=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
	const shuffle=<T>(values:readonly T[])=>{const copy=[...values];for(let i=copy.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;};
	const cases:{server:string;concurrency:number;repeat:number}[]=[];
	for(let repeat=1;repeat<=repeats;repeat++)for(const concurrency of shuffle([1,16,64]))for(const server of shuffle(FRAMEWORKS))cases.push({server,concurrency,repeat});
	return cases;
}
export function cpuPerRequest(before:any,after:any,successfulRequests:number) {
	if(before.pid!==after.pid)throw Error("CPU snapshots refer to different processes");
	const user=after.cpu.user-before.cpu.user,system=after.cpu.system-before.cpu.system;
	if(user<0||system<0||!Number.isFinite(user+system))throw Error("Invalid CPU counter delta");
	return successfulRequests>0?{cpuMs:(user+system)/1000,cpuMsPer1000:(user+system)/successfulRequests}:null;
}
export function summarizeFramework(cells:any[]) {
	return ["controlled","deployed"].flatMap(phase=>summarizeOhaCells(cells.filter(c=>c.phase===phase)).map(row=>{
		const runs=cells.filter(c=>c.phase===phase&&c.server===row.server&&c.concurrency===row.concurrency);
		const cpuRuns=runs.filter(c=>c.cpu);
		return {...row,phase,cpuMsPer1000:cpuRuns.length===runs.length&&row.successfulRequests?cpuRuns.reduce((n,c)=>n+c.cpu.cpuMs,0)/row.successfulRequests*1000:null,
			generatorCpuFractionMax:Math.max(0,...runs.map(c=>c.generatorCpuFraction??0))};
	}));
}
