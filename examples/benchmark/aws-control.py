"""AWS control plane for the benchmark; requires a current boto3 with lambda-web support.

Only the six bench-* functions are mutated. Credentials stay in the named SDK profile.
"""
import argparse
import datetime as dt
import json
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

SERVERS = {
    "node-http": "NodeHttpStack", "express": "ExpressStack", "hono": "HonoStack",
    "h3": "H3Stack", "bun-http": "BunHttpStack", "lambda-apigw": "LambdaApiGwStack",
}
WEB_SERVERS = ("node-http", "express", "hono", "h3")


def wait_for(get, done, timeout=240):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = get()
        if result.get("state") == "Failed" or result.get("updateStatus") == "Failed":
            raise RuntimeError(json.dumps(result, default=str))
        if done(result):
            return result
        time.sleep(2)
    raise TimeoutError("AWS resource did not stabilize within the bounded wait")


class Control:
    def __init__(self, profile, region):
        self.session = boto3.Session(profile_name=profile, region_name=region)
        config = Config(retries={"mode": "standard", "total_max_attempts": 4}, connect_timeout=10, read_timeout=40, ignore_configured_endpoint_urls=True)
        self.web = self.session.client("lambda-web", config=config)
        self.lam = self.session.client("lambda", config=config)
        self.cf = self.session.client("cloudformation", config=config)
        self.cw = self.session.client("cloudwatch", config=config)
        self.logs = self.session.client("logs", config=config)
        self.region = region

    def endpoint(self, server):
        return self.web.get_web_function_endpoint(functionName=f"bench-{server}", endpointName="prod")

    def update_endpoint(self, server, **kwargs):
        self.web.update_web_function_endpoint(functionName=f"bench-{server}", endpointName="prod", **kwargs)
        return wait_for(
            lambda: self.endpoint(server),
            lambda ep: ep.get("updateStatus") == "Successful"
            and all(ep.get(key, {}) == value for key, value in kwargs.items())
            and all(r.get("updateStatus") == "Successful" for r in ep.get("regionalEndpoints", {}).values()),
        )

    def snapshot(self):
        endpoints, configuration = {}, {}
        for server, stack in SERVERS.items():
            details = self.cf.describe_stacks(StackName=stack)["Stacks"][0]
            if details["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
                raise RuntimeError(f"{stack} is not deployed: {details['StackStatus']}")
            for output in details.get("Outputs", []):
                value = output["OutputValue"]
                if (".on.aws" in value or ".amazonaws.com" in value) and not value.startswith("arn:"):
                    endpoints[server] = (value if value.startswith("https://") else f"https://{value}").rstrip("/")
            if server in WEB_SERVERS:
                ep = self.endpoint(server)
                revision = self.web.get_web_function_revision(functionName=f"bench-{server}", revisionId=ep["revisionWeights"][0]["revisionId"])
                configuration[server] = {"endpoint": ep, "revision": revision}
            else:
                configuration[server] = self.lam.get_function_configuration(FunctionName=f"bench-{server}")
        if len(endpoints) != len(SERVERS):
            raise RuntimeError(f"Could not find all six AWS endpoints: {endpoints}")
        quotas = self.session.client("service-quotas")
        account_quotas = [q for page in quotas.get_paginator("list_service_quotas").paginate(ServiceCode="lambda")
                          for q in page["Quotas"] if "Web Functions" in q["QuotaName"] or q["QuotaName"] == "Concurrent executions"]
        return {"endpoints": endpoints, "configuration": configuration, "region": self.region, "accountQuotas": account_quotas}

    def cold(self, server):
        if server not in SERVERS:
            raise ValueError("Not a benchmark function")
        nonce = str(time.time_ns())
        if server not in WEB_SERVERS:
            name = f"bench-{server}"
            cfg = self.lam.get_function_configuration(FunctionName=name)
            variables = dict(cfg.get("Environment", {}).get("Variables", {}))
            self.lam.update_function_configuration(FunctionName=name, Environment={"Variables": {**variables, "COLD_NONCE": nonce}})
            self.lam.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 120})
            return {"configurationNonce": nonce}
        ep = self.endpoint(server)
        revision = self.web.get_web_function_revision(functionName=f"bench-{server}", revisionId=ep["revisionWeights"][0]["revisionId"])
        service = revision["serviceConfig"]
        service["environmentVariables"] = {**service.get("environmentVariables", {}), "COLD_NONCE": nonce}
        new = self.web.create_web_function_revision(functionName=f"bench-{server}", buildConfig=revision["buildConfig"], serviceConfig=service)
        revision_id = new["revisionId"]
        wait_for(lambda: self.web.get_web_function_revision(functionName=f"bench-{server}", revisionId=revision_id), lambda r: r["state"] == "Active")
        self.update_endpoint(server, revisionWeights=[{"revisionId": revision_id, "weight": 100}])
        return {"revisionId": revision_id}

    def restore(self, snapshot):
        restored = []
        for server in SERVERS:
            original = snapshot["configuration"][server]
            if server in WEB_SERVERS:
                ep = original["endpoint"]
                self.update_endpoint(server, revisionWeights=ep["revisionWeights"], scalingConfig=ep.get("scalingConfig", {}), throttleConfig=ep.get("throttleConfig", {}))
            else:
                name = f"bench-{server}"
                self.lam.update_function_configuration(FunctionName=name, Environment={"Variables": original.get("Environment", {}).get("Variables", {})})
                self.lam.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 120})
            restored.append(server)
        return {"restored": restored}

    def telemetry(self, start_iso):
        start = dt.datetime.fromisoformat(start_iso.replace("Z", "+00:00")) - dt.timedelta(minutes=1)
        end = dt.datetime.now(dt.timezone.utc)
        metrics = []
        names = {f"bench-{server}" for server in SERVERS}
        for namespace in ("AWS/Lambda/Web", "AWS/Lambda/Web/Usage", "AWS/Lambda"):
            for page in self.cw.get_paginator("list_metrics").paginate(Namespace=namespace):
                for metric in page["Metrics"]:
                    if any(d["Value"] in names for d in metric.get("Dimensions", [])):
                        stat = "Maximum" if any(k in metric["MetricName"] for k in ("Memory", "Concurrent", "Environments")) else "Sum"
                        result = self.cw.get_metric_statistics(**metric, StartTime=start, EndTime=end, Period=60, Statistics=[stat])
                        metrics.append({**metric, "statistic": stat, "datapoints": result.get("Datapoints", [])})
        groups = {}
        for page in self.logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix="/aws/lambda/"):
            for group in page["logGroups"]:
                if any(group["logGroupName"] in (f"/aws/lambda/{fn}", f"/aws/lambda/web/{fn}", f"/aws/lambda/web/{fn}.local") for fn in names):
                    events = []
                    for event_page in self.logs.get_paginator("filter_log_events").paginate(logGroupName=group["logGroupName"], startTime=int(start.timestamp()*1000)):
                        events.extend(event_page.get("events", []))
                    groups[group["logGroupName"]] = events
        return {"windowStart": start, "windowEnd": end, "metrics": metrics, "logGroups": groups}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("action", choices=("snapshot", "cold", "restore", "telemetry", "update-endpoint"))
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    try:
        control = Control(args.profile, args.region)
        if args.action == "snapshot":
            out = control.snapshot()
        elif args.action == "cold":
            out = control.cold(args.value)
        elif args.action == "restore":
            out = control.restore(json.load(sys.stdin))
        elif args.action == "telemetry":
            out = control.telemetry(args.value)
        else:
            server = args.value or "node-http"
            if server not in WEB_SERVERS:
                raise ValueError("Only benchmark Web Function endpoints may be updated")
            out = control.update_endpoint(server, **json.load(sys.stdin))
        print(json.dumps(out, default=str))
        return 0
    except (ClientError, TimeoutError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
