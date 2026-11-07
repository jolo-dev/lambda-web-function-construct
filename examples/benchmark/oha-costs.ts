export interface CostRates {
	webRequest: number; webCpu: number; webMemory: number;
	classicRequest: number; classicCompute: number; httpApi: number;
}
export interface CostAssumptions {
	monthlyRequests: number; days: number; webActiveCpuMsPerRequest: number;
	webResidentGbPerEnvironment: number; webEnvironments: number[];
	classicAllocatedGb: number; classicBilledMs: number[];
}
const METERS: Record<keyof CostRates,{usageType:string;units:string[]}> = {
	webRequest:{usageType:"EUC1-Lambda-Web-Request-ARM",units:["Request","Requests"]},
	webCpu:{usageType:"EUC1-Lambda-Web-vCPU-Second-ARM",units:["vCPU-Seconds"]},
	webMemory:{usageType:"EUC1-Lambda-Web-Memory-GB-Second-ARM",units:["GB-Seconds"]},
	classicRequest:{usageType:"EUC1-Request-ARM",units:["Request","Requests"]},
	classicCompute:{usageType:"EUC1-Lambda-GB-Second-ARM",units:["Lambda-GB-Second"]},
	httpApi:{usageType:"EUC1-ApiGatewayHttpRequest",units:["Requests"]},
};

/** Select exact meters, never a suffix matching Managed Instances or a discounted higher tier. */
export function extractCostRates(products: any[], region: string): CostRates {
	const entries = Object.entries(METERS).map(([key,meter])=>{
		const dimensions = products.filter(product=>product.product?.attributes?.regionCode === region && product.product.attributes.usagetype === meter.usageType)
			.flatMap(product=>Object.values(product.terms?.OnDemand ?? {}).flatMap((term:any)=>Object.values(term.priceDimensions ?? {})))
			.filter((dimension:any)=>dimension.beginRange === "0") as any[];
		if (dimensions.length !== 1) throw new Error(`Expected one first-tier ${region} price for ${meter.usageType}`);
		const dimension = dimensions[0], rate = Number(dimension.pricePerUnit?.USD);
		if (!meter.units.includes(dimension.unit) || !Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid unit or USD price for ${meter.usageType}`);
		return [key,rate];
	});
	return Object.fromEntries(entries) as unknown as CostRates;
}

/** Illustrative on-demand scenarios; no billed-duration inference from client/network latency. */
export function estimateCosts(rates: CostRates, assumptions: CostAssumptions) {
	const a = assumptions;
	const nonnegative = [a.monthlyRequests,a.webActiveCpuMsPerRequest,a.webResidentGbPerEnvironment,...a.classicBilledMs];
	if (nonnegative.some(value=>!Number.isFinite(value) || value < 0) || !Number.isSafeInteger(a.monthlyRequests)
		|| !Number.isFinite(a.days) || a.days <= 0 || !Number.isFinite(a.classicAllocatedGb) || a.classicAllocatedGb <= 0
		|| !a.webEnvironments.length || !a.classicBilledMs.length || a.webEnvironments.some(value=>!Number.isSafeInteger(value) || value <= 0)
		|| Object.values(rates).some(value=>!Number.isFinite(value) || value <= 0)) throw new Error("Invalid cost assumptions or rates");
	if (a.monthlyRequests > 300_000_000 || a.classicBilledMs.some(ms=>a.monthlyRequests*a.classicAllocatedGb*ms/1000 > 7_500_000_000)) {
		throw new Error("Scenario exceeds supported first-tier pricing; use a tiered calculator");
	}
	const residencySeconds = a.days*24*60*60;
	const web = a.webEnvironments.map(environments=>{
		const requestsUsd = a.monthlyRequests*rates.webRequest;
		const cpuUsd = a.monthlyRequests*a.webActiveCpuMsPerRequest/1000*rates.webCpu;
		const memoryUsd = environments*a.webResidentGbPerEnvironment*residencySeconds*rates.webMemory;
		return {environments,requestsUsd,cpuUsd,memoryUsd,totalUsd:requestsUsd+cpuUsd+memoryUsd};
	});
	const classic = ["bun-http","lambda-apigw"].flatMap(server=>a.classicBilledMs.map(billedMs=>{
		const requestsUsd = a.monthlyRequests*rates.classicRequest;
		const computeUsd = a.monthlyRequests*a.classicAllocatedGb*billedMs/1000*rates.classicCompute;
		const gatewayUsd = server === "lambda-apigw" ? a.monthlyRequests*rates.httpApi : 0;
		return {server,billedMs,requestsUsd,computeUsd,gatewayUsd,totalUsd:requestsUsd+computeUsd+gatewayUsd};
	}));
	return {web,classic};
}

const dollars = (value:number) => `$${value.toFixed(2)}`;

/** Evidence belongs to one run. Never attach another account's or day's billing to it. */
export function renderCosts(source:any, report:any) {
	if (!source || source.schemaVersion !== 1 || source.profile !== report.profile || source.region !== report.region
		|| source.reportStartedAt !== report.startedAt || (report.before?.identity?.Account && source.accountId !== report.before.identity.Account)) return null;
	const rates = extractCostRates(source.products,report.region);
	const a:CostAssumptions = source.assumptions, costs = estimateCosts(rates,a);
	const days = source.costExplorer?.response?.ResultsByTime ?? [];
	const groups = days.flatMap((day:any)=>day.Groups ?? []);
	const serviceCosts:Record<string,number> = {};
	for (const group of groups) {
		const metric = group.Metrics?.UnblendedCost;
		if (metric?.Unit !== "USD" || !Number.isFinite(Number(metric.Amount))) throw new Error("Invalid Cost Explorer currency or amount");
		serviceCosts[group.Keys[0]] = (serviceCosts[group.Keys[0]] ?? 0)+Number(metric.Amount);
	}
	const billing = {totalUsd:Object.values(serviceCosts).reduce((sum,value)=>sum+value,0),serviceCosts,
		estimated:!days.length || days.some((day:any)=>day.Estimated !== false),attributableToBenchmark:false};
	const tableRows = [
		...costs.web.map(row=>`| Web Functions — ${row.environments} resident environment${row.environments===1 ? "" : "s"} | ${a.classicBilledMs.map(()=>dollars(row.totalUsd)).join(" | ")} |`),
		...(["bun-http","lambda-apigw"] as const).map(server=>`| ${server === "bun-http" ? "Bun + Function URL" : "Classic Lambda + HTTP API Gateway"} | ${a.classicBilledMs.map(ms=>dollars(costs.classic.find(row=>row.server===server && row.billedMs===ms)!.totalUsd)).join(" | ")} |`),
	];
	const chartRows = [...costs.web.map(row=>({label:`Web · ${row.environments} resident env`,value:row.totalUsd,isWeb:true})),
		...costs.classic.map(row=>({label:`${row.server} · ${row.billedMs}ms`,value:row.totalUsd,isWeb:false}))];
	const components = [...costs.web.map(row=>`| Web · ${row.environments} resident env | ${dollars(row.requestsUsd)} | ${dollars(row.cpuUsd)} | ${dollars(row.memoryUsd)} | — | ${dollars(row.totalUsd)} |`),
		...costs.classic.map(row=>`| ${row.server} · ${row.billedMs}ms | ${dollars(row.requestsUsd)} | ${dollars(row.computeUsd)} | Included in compute | ${dollars(row.gatewayUsd)} | ${dollars(row.totalUsd)} |`)];
	const missingMeters = [
		...(!groups.some((group:any)=>String(group.Keys?.[1]).includes("Lambda-Web-")) ? ["Web Function"] : []),
		...(!groups.some((group:any)=>group.Keys?.[0] === "Amazon API Gateway") ? ["API Gateway"] : []),
	];
	const period = days.length ? `${days[0].TimePeriod.Start} to ${days[days.length-1].TimePeriod.End} (end exclusive, UTC)` : "the requested period";
	const directory = report.directory;
	const markdown = `## Estimated monthly costs

**Illustrative estimates, not the cost of executing this benchmark and not a measured framework cost ranking.** Prices are public on-demand USD rates for ${report.region}, queried ${source.pricingQueriedOn} using the AWS Price List API. All four Web frameworks share this pricing model; their individual CPU/memory costs were not measured by the oha run.

### ${a.monthlyRequests.toLocaleString("en-US")} requests over ${a.days} days

Lower cost is better **only within a scenario's stated assumptions**. The duration columns apply to classic Lambda; Web costs stay unchanged because only I/O waiting increases, not the assumed active CPU or resident environment count.

| Deployment | ${a.classicBilledMs.map(ms=>`${ms} ms classic billed duration ↓`).join(" | ")} |
| --- | ${a.classicBilledMs.map(()=>"---:").join(" | ")} |
${tableRows.join("\n")}

![Illustrative monthly deployment costs in USD; six labeled scenarios, lower is better under their stated assumptions.](${directory}/cost-estimates.svg)

### Assumptions and billing model

- **Web Functions:** ${a.webActiveCpuMsPerRequest} ms active CPU/request; ${a.webResidentGbPerEnvironment} GB consumed memory per environment; ${a.webEnvironments.join(" or ")} continuously resident environments for all ${a.days} days. These are sensitivity scenarios, not observed environment counts or endpoint caps. Memory is charged throughout residency, including idle time—not just while requests run. More memory, active CPU, resident environments or background activity increases the estimate; scale-to-zero or shorter residency reduces the memory component.
- **Classic Lambda:** ${a.classicAllocatedGb} GB ARM, matching the deployed examples; assumed ${a.classicBilledMs.join("/")} ms **billed duration per request**, not measured duration. WAN latency is not Lambda billed duration. The longer scenario adds I/O waiting while keeping Web active CPU/request unchanged.
- **API Gateway:** HTTP API request fees apply only to lambda-apigw. Function URLs have no API Gateway request fee. These scenarios stay within the first ${Number(300_000_000).toLocaleString("en-US")} HTTP API requests/month and first ARM Lambda compute tier.
- **Excluded:** free tier, credits, discounts/Savings Plans, taxes, data transfer, CloudWatch, ECR/S3, and initialization/background CPU beyond the stated assumptions. This is not an invoice or an extrapolation of the oha latency percentiles.

| Billing meter | Public rate (USD) |
| --- | ---: |
| Web requests | ${dollars(rates.webRequest*1_000_000)} / million |
| Web active CPU | $${rates.webCpu.toFixed(10)} / vCPU-second |
| Web consumed memory during residency | $${rates.webMemory.toFixed(10)} / GB-second |
| Classic requests (ARM) | ${dollars(rates.classicRequest*1_000_000)} / million |
| Classic ARM compute, first tier | $${rates.classicCompute.toFixed(10)} / GB-second |
| HTTP API, first tier | ${dollars(rates.httpApi*1_000_000)} / million |

### Cost components

Totals are calculated before rounding; displayed components may differ by a cent when summed.

| Scenario | Requests | CPU / classic compute | Web residency memory | HTTP API | Total ↓ |
| --- | ---: | ---: | ---: | ---: | ---: |
${components.join("\n")}

Formulas: Web = requests × request rate + requests × active CPU seconds/request × CPU rate + resident environments × consumed GB/environment × resident seconds × memory rate. Classic = requests × request rate + requests × allocated GB × billed seconds/request × compute rate + applicable HTTP API requests × gateway rate.

### Cost Explorer check — not benchmark attribution

Queried profile **${source.profile}**, account **${source.accountId}**, region **${source.region}**, for ${period}; response captured ${source.billingCapturedAt}. This covers the selected services for the **whole UTC day**, including other workloads and idle time, not just the oha run. Credits and refunds are excluded by the query.

${groups.length ? `Returned service charges total **${dollars(billing.totalUsd)}**, ${billing.estimated ? "marked provisional (Estimated=true) by Cost Explorer" : "not marked estimated by Cost Explorer"}.` : "Cost Explorer returned no cost rows; missing data is not a zero-cost measurement."}${billing.totalUsd === 0 ? " This is **not proof that the benchmark was free**." : " This total cannot be assigned to individual benchmark candidates."}

${Object.entries(serviceCosts).length ? `| Returned service | Unblended cost (USD) |\n| --- | ---: |\n${Object.entries(serviceCosts).map(([service,total])=>`| ${service} | ${dollars(total)} |`).join("\n")}\n` : ""}
${missingMeters.length ? `${missingMeters.join(" and ")} billing rows are absent from this response; do not interpret them as zero usage or a finalized bill.\n` : ""}
${source.costExplorer?.resourceLevel?.available === false ? "Resource-level Cost Explorer reporting was unavailable because it requires payer-account opt-in. No billing preferences were changed. " : ""}This service/day query cannot attribute actual costs to the six functions. Reporting delays and account allowances can affect the returned charges; public-price estimates above deliberately exclude them.

Evidence: [selected raw AWS pricing products and Cost Explorer query/response](${directory}/cost-source.json), [machine-readable assumptions, components and estimates](${directory}/cost-estimates.json). Pricing references: [Lambda](https://aws.amazon.com/lambda/pricing/), [HTTP API Gateway](https://aws.amazon.com/api-gateway/pricing/). Regenerate offline with \`bun run bench:report:oha\`; this does not refresh billing data or send requests to AWS.
`;
	return {markdown,chartRows,estimates:{currency:"USD",assumptions:a,rates,...costs,billing}};
}
