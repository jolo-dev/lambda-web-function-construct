import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { median, verifiedColdTrials } from "./comparison";
import { summarizeOhaCells } from "./oha";
import { renderCosts } from "./oha-costs";

const WEB_SERVERS = new Set(["node-http", "express", "hono", "h3"]);
const START = "<!-- oha-visuals:start -->";
const END = "<!-- oha-visuals:end -->";
const fmt = (value: number) => value.toFixed(2);
const XML_ENTITIES: Record<string,string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => XML_ENTITIES[character]!);

interface ChartRow { label: string; value: number; samples?: number[]; isWeb?: boolean }
interface ChartOptions { title: string; subtitle: string; unit: string; higherIsBetter: boolean; rows: ChartRow[]; caption?: string; legend?: { web: string; classic?: string } }
/** A zero-based bar chart; cold-start dots show actual trials rather than invented error bars. */
export function barChartSvg(options: ChartOptions): string {
	const rows = options.rows.filter(row=>Number.isFinite(row.value) && row.value >= 0).slice()
		.sort((a,b)=>options.higherIsBetter ? b.value-a.value : a.value-b.value);
	const maximum = Math.max(1,...rows.flatMap(row=>[row.value,...(row.samples ?? [])]));
	const step = 10**Math.floor(Math.log10(maximum)), bound = Math.ceil(maximum/step)*step;
	const width = 960, height = 216+rows.length*56, left = 226, right = 812, bottom = 170+Math.max(0,rows.length-1)*56;
	const x = (value: number) => left+value/bound*(right-left);
	const description = `${options.subtitle}. ${rows.map(row=>`${row.label}: ${fmt(row.value)} ${options.unit}`).join("; ")}. Bars start at zero. Dots, when present, are individual observed trials.`;
	const ticks = Array.from({length:5},(_,i)=>{
		const value = bound*i/4, position = x(value);
		return `<line x1="${position}" x2="${position}" y1="124" y2="${bottom}" stroke="#e2e8f0"/><text x="${position}" y="${bottom+26}" text-anchor="middle" font-size="13" fill="#475569">${bound > 10 ? value.toFixed(0) : value.toFixed(2)}</text>`;
	}).join("\n");
	const bars = rows.map((row,index)=>{
		const y = 142+index*56, color = row.isWeb ? "#146d64" : "#8b5b20";
		const dots = (row.samples ?? []).map(value=>`<circle data-sample="${value}" cx="${x(value)}" cy="${y}" r="3.5" fill="white" stroke="#0f172a" stroke-width="1.5"/>`).join("");
		return `<g><text x="38" y="${y+5}" font-size="16" fill="#0f172a">${escapeXml(row.label)}</text><rect x="${left}" y="${y-12}" width="${x(row.value)-left}" height="24" fill="${color}"/>${dots}<text x="922" y="${y+5}" text-anchor="end" font-size="16" font-weight="600" fill="#0f172a">${fmt(row.value)}</text></g>`;
	}).join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description" data-domain-min="0" data-domain-max="${bound}">
<title id="chart-title">${escapeXml(options.title)}</title><desc id="chart-description">${escapeXml(description)}</desc>
<rect width="${width}" height="${height}" fill="white"/>
<g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
<text x="38" y="38" font-size="24" font-weight="650" fill="#0f172a">${escapeXml(options.title)}</text>
<text x="38" y="66" font-size="13" fill="#475569">${escapeXml(options.subtitle)}</text>
<rect x="38" y="88" width="12" height="12" fill="#146d64"/><text x="58" y="99" font-size="13" fill="#334155">${escapeXml(options.legend?.web ?? "Web Functions")}</text>
${!options.legend || options.legend.classic ? `<rect x="204" y="88" width="12" height="12" fill="#8b5b20"/><text x="224" y="99" font-size="13" fill="#334155">${escapeXml(options.legend?.classic ?? "Classic Event Lambda")}</text>` : ""}
<text x="922" y="99" text-anchor="end" font-size="13" fill="#334155">${escapeXml(options.unit)} · ${options.higherIsBetter ? "higher" : "lower"} is better</text>
${ticks}
<line x1="${left}" x2="${left}" y1="124" y2="${bottom}" stroke="#94a3b8"/>
${bars}
<text x="38" y="${height-24}" font-size="12" fill="#475569">${escapeXml(options.caption ?? (rows.some(row=>row.samples?.length) ? "Bars: median first-request time. Dots: individual verified trials. Earlier AWS measurements, not oha cold-start trials." : "GET /io?delayMs=30 · c=64 · 2xx responses only · aggregate throughput across repeats"))}</text>
</g></svg>\n`;
}

export function coldStartRows(source: any): { server: string; trialsMs: number[]; medianMs: number }[] {
	return (source?.coldStarts ?? []).flatMap((entry: any) => {
		const trials = verifiedColdTrials(entry.trials ?? []).filter((trial: any)=>{
			if (trial.status !== 200 || !Number.isFinite(trial.elapsedMs) || trial.elapsedMs <= 0) return false;
			if (!trial.revisionId && !trial.headers?.["x-lambda-request-id"]) return false;
			try { const body = JSON.parse(trial.body); return body.ok === true && body.server === entry.server; }
			catch { return false; }
		});
		const trialsMs = trials.map((trial: any)=>trial.elapsedMs);
		return trialsMs.length ? [{ server: entry.server, trialsMs, medianMs: median(trialsMs) }] : [];
	});
}

export function enhanceOhaMarkdown(markdown: string, report: any, coldSource: any, costSource: any = null) {
	const rows = summarizeOhaCells(report.cells).filter(row=>row.concurrency === 64);
	const throughputSvg = barChartSvg({ title: "Concurrent I/O throughput at c=64", subtitle: "Warm AWS requests · 30 ms asynchronous I/O · successful requests per second",
		unit: "requests/sec", higherIsBetter: true,
		rows: rows.map(row=>({label:row.server,value:row.successfulRps,isWeb:WEB_SERVERS.has(row.server)})) });
	const matches = coldSource?.profile === report.profile && coldSource?.region === report.region;
	const coldRows = matches ? coldStartRows(coldSource) : [];
	const coldSvg = coldRows.length ? barChartSvg({ title: "Cold-start first-request time", subtitle: "Earlier verified AWS trials · medians, with individual trials shown as dots",
		unit: "ms", higherIsBetter:false,
		rows:coldRows.map(row=>({label:row.server,value:row.medianMs,samples:row.trialsMs,isWeb:WEB_SERVERS.has(row.server)})) }) : null;
	const coldTable = `| Server | Verified trials | First-request times ↓ ms | Median ↓ ms |\n| --- | --- | --- | --- |\n${coldRows.map(row=>`| ${row.server} | ${row.trialsMs.length} | ${row.trialsMs.map(fmt).join(", ")} | ${fmt(row.medianMs)} |`).join("\n")}\n`;
	const coldSection = coldSvg ? `## Cold-start times — earlier AWS trials\n\n**Not measured by oha during this warm I/O run.** These are the earlier verified AWS first-request-after-replacement trials for the same profile and region. Web responses must match the replacement revision; classic responses must identify a Lambda invocation. Invalid service-health responses and stale Web revision responses are excluded.\n\n${coldTable}\n![Cold-start median first-request times in milliseconds; lower is better. Dots show the individual verified trials.](${report.directory}/cold-start-times.svg)\n\nThese times include client/network overhead, not just platform or framework initialization. Web Functions may prepare environments before the first request. Three trials per candidate are too few to establish a reliable cold-start ranking or predict a simultaneous cold burst.\n\nProvenance: [archived cold-start source](${report.directory}/cold-start-source.json), extracted from [the earlier AWS dataset](results/aws-latest.json). Source dataset started ${coldSource.startedAt}; its coldStartSource and correction metadata identify the earlier/replacement trials, including the API Gateway /healthz correction.\n` : "## Cold-start times\n\nNo matching verified AWS cold-start samples are available for this profile and region. Cold-start times were not collected during the oha warm I/O run.\n";
	const costs = renderCosts(costSource,report);
	const assumptions = costs?.estimates.assumptions;
	const costSvg = costs && assumptions ? barChartSvg({title:"Estimated monthly cost",
		subtitle:`${assumptions.monthlyRequests/1_000_000}M requests / ${assumptions.days} days · ${assumptions.classicAllocatedGb} GB ARM classic · continuous Web residency`,
		unit:`USD / ${assumptions.days} days`,higherIsBetter:false,rows:costs.chartRows,
		caption:`Illustrative scenarios, not benchmark charges · Web: ${assumptions.webActiveCpuMsPerRequest}ms active CPU/request, ${assumptions.webResidentGbPerEnvironment} GB/resident environment`}) : null;
	const costSection = costs?.markdown ?? "## Estimated monthly costs\n\nNo matching cost evidence was archived for this run. No actual benchmark charge or cost ranking can be inferred.\n";
	const block = `${START}\n### Concurrent I/O throughput at c=64\n\n![Successful concurrent I/O throughput for the six candidates at c=64, in requests per second; higher is better.](${report.directory}/io-throughput-c64.svg)\n\nOnly HTTP 2xx responses count. The graph summarizes the c=64 rows above, not per-environment capacity or a cost comparison.\n\n${coldSection}\n${costSection}\n${END}\n\n`;
	const start = markdown.indexOf(START), end = markdown.indexOf(END);
	const clean = start >= 0 && end >= start ? markdown.slice(0,start)+markdown.slice(end+END.length).replace(/^\n*/,"") : markdown;
	const anchor = "## CloudWatch diagnostic evidence";
	if (!clean.includes(anchor)) throw new Error("Cannot locate oha report results section");
	return { markdown:clean.replace(anchor,block+anchor), throughputSvg, coldSvg, costSvg, costEstimates:costs?.estimates ?? null };
}

/** Rebuild visuals locally; never launches load or changes AWS configuration. */
export function writeOhaReport(markdown: string, report: any, baseDirectory: string) {
	const sourcePath = path.join(baseDirectory,"results/aws-latest.json");
	const coldSource = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath,"utf8")) : null;
	const directory = path.join(baseDirectory,report.directory);
	const costSourcePath = path.join(directory,"cost-source.json");
	const costSource = existsSync(costSourcePath) ? JSON.parse(readFileSync(costSourcePath,"utf8")) : null;
	const output = enhanceOhaMarkdown(markdown,report,coldSource,costSource);
	writeFileSync(path.join(directory,"io-throughput-c64.svg"),output.throughputSvg);
	if (output.coldSvg) {
		writeFileSync(path.join(directory,"cold-start-times.svg"),output.coldSvg);
		writeFileSync(path.join(directory,"cold-start-source.json"),JSON.stringify({ source:"results/aws-latest.json", profile:coldSource.profile, region:coldSource.region,
			startedAt:coldSource.startedAt, coldStartSource:coldSource.coldStartSource, corrections:coldSource.corrections, coldStarts:coldSource.coldStarts },null,2)+"\n");
	}
	if (output.costSvg) {
		writeFileSync(path.join(directory,"cost-estimates.svg"),output.costSvg);
		writeFileSync(path.join(directory,"cost-estimates.json"),JSON.stringify({
			source:"cost-source.json",sourceSha256:createHash("sha256").update(readFileSync(costSourcePath)).digest("hex"),
			...output.costEstimates,
		},null,2)+"\n");
	}
	writeFileSync(path.join(baseDirectory,"OHA_RESULTS.md"),output.markdown);
	writeFileSync(path.join(directory,"RESULTS.md"),output.markdown.replaceAll(`${report.directory}/`,"").replaceAll("](results/","](../"));
}

if (import.meta.main) {
	const report = JSON.parse(readFileSync(path.join(import.meta.dir,"results/oha-aws-latest.json"),"utf8"));
	writeOhaReport(readFileSync(path.join(import.meta.dir,"OHA_RESULTS.md"),"utf8"),report,import.meta.dir);
	console.log("Updated OHA_RESULTS.md, graphs, cost estimates, and archived report without rerunning the benchmark");
}
