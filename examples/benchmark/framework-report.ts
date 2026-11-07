import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import path from "node:path";
import {FRAMEWORKS,summarizeFramework} from "./framework";
import {barChartSvg} from "./oha-report";
const fmt=(value:number|null|undefined)=>value==null?"not attributable":value.toFixed(2);
const table=(headers:string[],rows:any[][])=>`| ${headers.join(" | ")} |\n| ${headers.map(()=>"---").join(" | ")} |\n${rows.map(row=>`| ${row.join(" | ")} |`).join("\n")}\n`;
export function renderFrameworkReport(report:any){
 const cells=report.cells??[],summaries=summarizeFramework(cells),directory=report.directory;
 const rows=(phase:string)=>summaries.filter(r=>r.phase===phase).map(row=>[row.server,row.concurrency,row.repeats,fmt(row.successfulRps),`${fmt(row.rpsRange[0])}–${fmt(row.rpsRange[1])}`,fmt(row.p50Ms),fmt(row.p95Ms),fmt(row.cpuMsPer1000),`${fmt(row.generatorCpuFractionMax*100)}%`,row.httpFailures+row.transportErrors]);
 const paired:any[][]=[];
 for(const concurrency of [1,16,64])for(let repeat=1;repeat<=report.repeats;repeat++){
  const pair=["express","hono"].map(server=>cells.find((c:any)=>c.phase==="controlled"&&c.server===server&&c.repeat===repeat&&c.concurrency===concurrency));
  if(pair.some(c=>!c||!c.validUnconstrainedSample))continue;
  const [express,hono]=pair;paired.push([concurrency,repeat,fmt(express.successfulRps),fmt(hono.successfulRps),(express.successfulRps/hono.successfulRps).toFixed(4),express.cpu&&hono.cpu?(express.cpu.cpuMsPer1000/hono.cpu.cpuMsPer1000).toFixed(4):"not attributable"]);
 }
 const controlled=summaries.filter(r=>r.phase==="controlled"&&r.concurrency===64);
 const graphs:Record<string,string>={};
 const graph=(filename:string,title:string,unit:string,higherIsBetter:boolean,values:any[])=>{graphs[filename]=barChartSvg({title,subtitle:`Controlled localhost HTTP · Node ${report.host?.node??"24"} · c=64 · one server CPU`,unit,higherIsBetter,rows:values,legend:{web:"Controlled Node servers"},caption:"Minimal identical response · generator on separate CPU cores · inspect errors and generator utilization before ranking"});};
 graph("controlled-throughput.svg","Controlled framework throughput","successful requests/sec",true,controlled.map(row=>({label:row.server,value:row.successfulRps,isWeb:true})));
 graph("controlled-cpu.svg","Controlled server CPU per 1,000 successes","CPU ms / 1,000 requests",false,controlled.filter(row=>row.cpuMsPer1000!==null).map(row=>({label:row.server,value:row.cpuMsPer1000!,isWeb:true})));
 const warnings=cells.filter((c:any)=>c.phase==="controlled"&&!c.validUnconstrainedSample).length;
 const cleanup=report.cleanup;
 const markdown=`# Framework-focused AWS-hosted benchmark

Status: **${report.status}** · Profile: **${report.profile??""}** · Region: **${report.region??""}** · Started: ${report.startedAt}

## What this experiment can tell us

This separates framework/Node-adapter efficiency from Lambda endpoint and WAN effects. It does not overwrite the earlier 30ms-I/O oha benchmark. Controlled throughput, CPU efficiency and deployed endpoint latency answer different questions; do not compare absolute RPS across the two passes as though they were the same environment.

## Method and provenance

- Temporary non-burstable **c7g.xlarge**, Linux ARM64, Frankfurt. Server pinned to CPU **3**; oha pinned to CPUs **0–2**. Affinity separates the benchmark processes, not all kernel/SSM background activity.
- Controlled fixtures are separately bundled with the same dependency versions; only the selected framework is loaded in each server process. Each returns the same 11-byte JSON body and configured headers, without artificial I/O or per-request telemetry sampling. Hono uses @hono/node-server; h3 uses its Node adapter. This tests those implementations, not every possible adapter/runtime.
- One fresh Node server per controlled trial; ${report.warmupSeconds}s warmup then ${report.durationSeconds}s measurement. **${report.repeats} randomized repeats** at c=1,16,64, grouped into same-concurrency four-framework blocks. Seed **${report.seed??""}** is saved for reproducibility.
- CPU is the delta of **process.cpuUsage()** from the same server PID around the measured interval, divided by successful requests. It includes the whole Node server process and small telemetry boundary overhead, not an isolated router function. Peak RSS in raw snapshots covers the process lifetime, including startup/warmup.
- Generator CPU usage uses Bun's microsecond counters divided by wall time and three available generator cores. Controlled cells at >=85% aggregate generator CPU, or with HTTP/transport failures, are flagged rather than treated as clean unconstrained samples. Aggregate utilization is a diagnostic, not proof that no single-thread or network bottleneck exists.
- Deployed pass targets existing HTTPS /ping routes from the same Frankfurt host, with **1000 RPS ceiling** and oha latency correction. c is the maximum active connection count; achieved load can be below that ceiling, especially at c=1. This is **not maximum capacity**. Existing deployed response bodies identify their server and are not identical to the controlled fixture. Runtime patch levels can differ from the EC2 Node version.
- No deployed Lambda settings or code changes. Raw measured/warmup JSON, commands, hashes, versions, CPU snapshots, generator usage and configuration snapshots are retained. Throughput sums 2xx counts / elapsed durations; reported latency percentiles are medians of repeat-level successful percentiles, not pooled percentiles.
- With five repeats, small differences remain **not statistically conclusive**. Paired ratios below describe these runs, not a population confidence interval or proof of general framework superiority.

Host tools: Node **${report.host?.node??"unknown"}**, **${report.host?.oha??"unknown"}**, Bun **${report.host?.bun??"unknown"}**. Packages: ${Object.entries(report.versions??{}).map(([name,version])=>`${name} ${version}`).join(", ")}.

## Controlled framework efficiency

Higher RPS is better; lower latency and CPU/request are better. Flagged controlled cells: **${warnings}**. Inspect individual trials before ranking; the table preserves all measurements, including flagged ones.

${table(["Server","c","Repeats","Successful RPS ↑","Run RPS range","Median run p50 ↓ ms","Median run p95 ↓ ms","Server CPU ↓ ms/1k successes","Max generator CPU fraction","Errors"],rows("controlled"))}
![Controlled throughput at c=64, higher is better.](${directory}/controlled-throughput.svg)

![Controlled server CPU per 1,000 successful requests at c=64, lower is better.](${directory}/controlled-cpu.svg)

## Express versus Hono — paired controlled observations

RPS ratio = Express / Hono: above 1 favors Express throughput. CPU ratio = Express / Hono CPU per successful request: below 1 favors Express efficiency. Only paired blocks where both samples passed the basic error/generator-utilization checks appear here.

${table(["c","Repeat","Express RPS","Hono RPS","Express/Hono RPS ratio","Express/Hono CPU ratio"],paired)}

## Deployed Web Function latency under bounded load

**1000 RPS ceiling, not maximum capacity.** Use latency/error observations at comparable achieved load; reaching the ceiling does not establish identical throughput capacity. CPU cannot be attributed by making a single telemetry request to a load-balanced function, so no per-cell server CPU is invented here.

**Corrected latency includes scheduling backlog**, not just HTTP response time. At c=1, the single connection cannot sustain the requested 1000 RPS: achieved throughput is much lower and corrected percentiles grow into seconds as requests fall behind their scheduled start times. Those values describe an overloaded arrival schedule, **not multi-second Lambda response times**. Do not compare them directly with the uncorrected controlled-pass percentiles or use them to rank endpoint service latency.

${table(["Server","c","Repeats","Successful RPS (bounded)","Run RPS range","Median run corrected p50 ↓ ms","Median run corrected p95 ↓ ms","Server CPU ms/1k","Max generator CPU fraction","Errors"],rows("deployed"))}
## CloudWatch CPU diagnostics

[CloudWatch evidence](${directory}/cloudwatch.json) contains whole-function CPU and executed-request aggregates over minute buckets spanning the deployed pass, including warmups, idle/background activity and possible unrelated traffic. These are **not per-cell CPU** measurements and are not substituted for the controlled same-PID measurements. Units and bucket boundaries are retained in the raw AWS response. Missing series are not zero.

## Cleanup and artifacts

${cleanup?`Instance terminated: **${cleanup.instanceTerminated??false}**. Runner stack deletion independently verified: **${cleanup.stackDeletionVerified??false}**. Deployed configuration unchanged on read-back: **${cleanup.configurationUnchanged??"unknown"}**.`:"Cleanup verification is not attached yet; do not assume the temporary infrastructure has been removed."}

- [Run manifest and configuration](${directory}/manifest.json)
- [Initial deployed configuration](${directory}/configuration-before.json)
- [Final deployed configuration](${directory}/configuration-after.json)
- [Cleanup/recovery record](${directory}/recovery.json)
- Raw oha output, CPU snapshots, affinity evidence and commands: ${directory}/raw/
- Tool download digests and fixture hashes: run-config.json in that directory.
- Original I/O measurements: [OHA_RESULTS.md](OHA_RESULTS.md).

Reproduce: \`bun run bench:run:framework --profile jolo --region eu-central-1\`. This provisions a billed temporary EC2 runner and removes it after retrieving results. Shared CDK bootstrap assets are not destroyed. Regenerate this report offline with \`bun run bench:report:framework\`.
${report.error?`\nRun error: ${report.error}\n`:""}`;
 return {markdown,graphs};
}
if(import.meta.main){
 const base=import.meta.dir,report=JSON.parse(readFileSync(path.join(base,"results/framework-latest.json"),"utf8")),directory=path.join(base,report.directory);
 for(const cell of [...report.cells,...report.warmups])if(createHash("sha256").update(readFileSync(path.join(directory,"raw",cell.rawFile))).digest("hex")!==cell.rawSha256)throw Error("Framework raw artifact checksum mismatch");
 if(existsSync(path.join(directory,"recovery.json")))report.cleanup=JSON.parse(readFileSync(path.join(directory,"recovery.json"),"utf8"));
 const output=renderFrameworkReport(report);writeFileSync(path.join(base,"FRAMEWORK_RESULTS.md"),output.markdown);
 writeFileSync(path.join(directory,"RESULTS.md"),output.markdown.replaceAll(`${report.directory}/`,"").replaceAll("](OHA_RESULTS.md)","](../../OHA_RESULTS.md)"));
 for(const [filename,svg] of Object.entries(output.graphs))writeFileSync(path.join(directory,filename),svg);
 console.log(`Updated FRAMEWORK_RESULTS.md; verified ${report.cells.length+report.warmups.length} raw artifacts`);
}
