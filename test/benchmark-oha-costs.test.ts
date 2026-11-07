import { expect, test } from "bun:test";
import { estimateCosts, extractCostRates, renderCosts } from "../examples/benchmark/oha-costs";
import { barChartSvg, enhanceOhaMarkdown } from "../examples/benchmark/oha-report";

function product(usageType: string, unit: string, rate: number, beginRange = "0", region = "eu-central-1") {
	return { product: { sku: usageType, attributes: { regionCode: region, usagetype: usageType } }, terms: { OnDemand: { term: {
		priceDimensions: { dimension: { unit, beginRange, endRange: "Inf", pricePerUnit: { USD: String(rate) } } },
	} } } };
}
const products = [
	product("EUC1-Lambda-Web-Request-ARM","Request",0.0000003),
	product("EUC1-Lambda-Web-vCPU-Second-ARM","vCPU-Seconds",0.0000349964),
	product("EUC1-Lambda-Web-Memory-GB-Second-ARM","GB-Seconds",0.0000046334),
	product("EUC1-Request-ARM","Requests",0.0000002),
	product("EUC1-Lambda-GB-Second-ARM","Lambda-GB-Second",0.0000133334),
	product("EUC1-ApiGatewayHttpRequest","Requests",0.0000012),
	product("EUC1-Lambda-Managed-Instances-Request-ARM","Requests",1),
	product("EUC1-ApiGatewayHttpRequest","Requests",0.00000108,"300000000"),
	product("EUC1-Lambda-Web-Request-ARM","Request",9,"0","us-east-1"),
];
const assumptions = { monthlyRequests: 10_000_000, days: 30, webActiveCpuMsPerRequest: 1,
	webResidentGbPerEnvironment: 0.25, webEnvironments: [1,8], classicAllocatedGb: 2, classicBilledMs: [50,500] };
const report = { profile:"jolo", region:"eu-central-1", startedAt:"2026-11-01T22:03:18.143Z", directory:"results/oha-test", before:{identity:{Account:"123456789012"}} };
const evidence = { schemaVersion:1, profile:report.profile, region:report.region, accountId:"123456789012", reportStartedAt:report.startedAt,
	pricingQueriedOn:"2026-11-02", billingCapturedAt:"2026-11-02T12:00:00Z", products, assumptions,
	costExplorer:{ resourceLevel:{available:false,message:"Resource-level data granularity is an opt-in only feature"}, response:{ResultsByTime:[{
		TimePeriod:{Start:"2026-11-01",End:"2026-11-02"}, Estimated:true, Groups:[{Keys:["AWS Lambda","EUC1-Request-ARM"],Metrics:{UnblendedCost:{Amount:"0",Unit:"USD"}}}],
	}] } },
};

test("price selection uses exact Frankfurt ARM meters and first-tier rates", () => {
	const rates = extractCostRates(products,"eu-central-1");
	expect(rates.classicRequest).toBe(0.0000002);
	expect(rates.httpApi).toBe(0.0000012);
	expect(rates.webRequest).toBe(0.0000003);
	expect(()=>extractCostRates(products.filter(p=>p.product.attributes.usagetype!=="EUC1-Lambda-Web-Memory-GB-Second-ARM"),"eu-central-1")).toThrow();
	expect(()=>extractCostRates([...products,products[0]],"eu-central-1")).toThrow();
	expect(()=>extractCostRates([product("EUC1-Request-ARM","Millions",0.2),...products.slice(0,3),...products.slice(4)],"eu-central-1")).toThrow();
});

test("monthly estimates charge Web memory for the entire resident month", () => {
	const costs = estimateCosts(extractCostRates(products,"eu-central-1"),assumptions);
	expect(costs.web[0].requestsUsd).toBeCloseTo(3,8);
	expect(costs.web[0].cpuUsd).toBeCloseTo(0.349964,8);
	expect(costs.web[0].memoryUsd).toBeCloseTo(3.0024432,8);
	expect(costs.web[0].totalUsd).toBeCloseTo(6.3524072,8);
	expect(costs.web[1].totalUsd).toBeCloseTo(27.3695096,8);
	const noRequests = estimateCosts(extractCostRates(products,"eu-central-1"),{...assumptions,monthlyRequests:0});
	expect(noRequests.web[0].memoryUsd).toBeCloseTo(3.0024432,8);
	expect(noRequests.web[0].cpuUsd).toBe(0);
});

test("classic billed-duration scenarios include gateway fees only for API Gateway", () => {
	const costs = estimateCosts(extractCostRates(products,"eu-central-1"),assumptions);
	const find = (server: string, billedMs: number) => costs.classic.find(row=>row.server===server && row.billedMs===billedMs)!;
	expect(find("bun-http",50).totalUsd).toBeCloseTo(15.3334,8);
	expect(find("bun-http",50).gatewayUsd).toBe(0);
	expect(find("lambda-apigw",50).totalUsd).toBeCloseTo(27.3334,8);
	expect(find("lambda-apigw",50).gatewayUsd).toBeCloseTo(12,8);
	expect(find("bun-http",500).totalUsd).toBeCloseTo(135.334,8);
	expect(find("lambda-apigw",500).totalUsd).toBeCloseTo(147.334,8);
});

test("invalid assumptions and volumes outside the supported pricing tier fail explicitly", () => {
	const rates = extractCostRates(products,"eu-central-1");
	for (const overrides of [{days:-1},{webActiveCpuMsPerRequest:NaN},{webEnvironments:[0]},{classicBilledMs:[-1]},{monthlyRequests:301_000_000}]) {
		expect(()=>estimateCosts(rates,{...assumptions,...overrides})).toThrow();
	}
});

test("report distinguishes estimated account billing from scenario costs and never invents a free benchmark", () => {
	const output = renderCosts(evidence,report)!;
	expect(output.markdown).toContain("$6.35");
	expect(output.markdown).toContain("$147.33");
	expect(output.markdown).toContain("provisional");
	expect(output.markdown).toContain("not proof that the benchmark was free");
	expect(output.markdown).toContain("not a measured framework cost ranking");
	expect(output.markdown).toContain("WAN latency is not Lambda billed duration");
	expect(output.markdown).toContain("cost-source.json");
	expect(output.chartRows).toHaveLength(6);
	expect(output.estimates.billing.totalUsd).toBe(0);
	for (const overrides of [{region:"us-east-1"},{profile:"other"},{startedAt:"other"},{before:{identity:{Account:"other"}}}]) {
		expect(renderCosts(evidence,{...report,...overrides})).toBeNull();
	}
	expect(renderCosts(null,report)).toBeNull();
});

test("cost chart and section follow the cold-start section and survive offline regeneration", () => {
	const markdown = "# Report\n\n## Results\n\n| Server | RPS |\n| --- | --- |\n\n## CloudWatch diagnostic evidence\n\nExisting diagnostics.\n";
	const input = {...report,cells:[]};
	const output = enhanceOhaMarkdown(markdown,input,null,evidence);
	expect(output.markdown).toContain("Estimated monthly costs");
	expect(output.markdown).toContain("cost-estimates.svg");
	expect(output.markdown.indexOf("## Estimated monthly costs")).toBeGreaterThan(output.markdown.indexOf("## Cold-start times"));
	expect(output.costSvg).toContain("6.35");
	expect(output.costSvg).not.toContain("GET /io?delayMs=30");
	expect(output.costSvg).toContain("Illustrative scenarios");
	expect(enhanceOhaMarkdown(output.markdown,input,null,evidence).markdown).toBe(output.markdown);
	const unavailable = enhanceOhaMarkdown(output.markdown,input,null,null);
	expect(unavailable.costSvg).toBeNull();
	expect(unavailable.markdown).not.toContain("cost-estimates.svg");
});

test("cost graph uses the archived assumptions rather than hard-coded volume or duration", () => {
	const source = {...evidence,assumptions:{...assumptions,monthlyRequests:1_000_000,days:15}};
	const output = enhanceOhaMarkdown("## Results\n\n## CloudWatch diagnostic evidence\n",{...report,cells:[]},null,source);
	expect(output.costSvg).toContain("1M requests / 15 days");
	expect(output.costSvg).toContain("USD / 15 days");
	expect(output.costSvg).not.toContain("10M requests");
});

test("shared chart accepts a scenario-specific caption without changing its units", () => {
	const svg = barChartSvg({title:"Costs",subtitle:"Illustrative monthly estimates",unit:"USD / month",higherIsBetter:false,
		caption:"Scenarios only — not actual benchmark charges",rows:[{label:"Web",value:6.35,isWeb:true}]});
	expect(svg).toContain("Scenarios only — not actual benchmark charges");
	expect(svg).not.toContain("2xx responses");
});
