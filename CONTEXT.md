# Lambda Web Function Benchmark & Construct

Defines and deploys AWS Lambda Web Functions and evaluates HTTP servers across Web Functions, a Bun Container Image Function, and Classic Event Lambda + HTTP API Gateway, both in LocalStack and real AWS.

## Language

### Compute Form Factors & Resource Model

**Web Function**:
A top-level AWS Lambda resource representing a `nodejs24.x` HTTP server application that listens on a network port and contains child Revisions and Endpoints.
_Avoid_: Event Function, Function URL, Lambda Handler

**Revision**:
An immutable snapshot of a Web Function's deployment archive and runtime configuration (`maxConcurrencyPerEnvironment`, timeout, environment variables, and telemetry levels).
_Avoid_: Version, Alias, Build

**Endpoint**:
A network entry point for a Web Function with its own domain name, authentication mode (`IamAuth` or `ApplicationManaged`), regional scope (`HomeRegion`, `MultiRegion`, or `PerRegion`), traffic limits, and revision weights.
_Avoid_: Function URL, Stage, Gateway

**Execution Environment**:
An isolated compute sandbox that initializes a server once and handles requests—multiplexing up to `maxConcurrencyPerEnvironment` concurrent HTTP requests per sandbox for a Web Function, or handling one invocation at a time per sandbox for a classic Event Function, regardless of ZIP or container packaging.
_Avoid_: Instance, VM

**Container Image Function**:
A standard AWS Lambda Event Function packaged as an OCI container image (`PackageType: Image`) and exposed over HTTPS via a Lambda Function URL, used to host runtimes not supported by Web Functions (such as Bun's native `Bun.serve` HTTP server).
_Avoid_: Web Function, ECS Task

**Classic Event Lambda + HTTP API Gateway**:
A traditional serverless HTTP backend composed of a Node.js Lambda Event Function (`AWS::Lambda::Function`) fronted by Amazon API Gateway HTTP API v2 (`AWS::ApiGatewayV2::Api`), where each request is translated into a JSON event payload and invokes one isolated handler at a time per sandbox.
_Avoid_: Web Function, Function URL

### Benchmarking

**Candidate Server**:
One of the six HTTP server implementations under comparative evaluation in `examples/` (`examples/node-http`, `examples/express`, `examples/hono`, and `examples/h3` on Lambda Web Functions; `examples/lambda-apigw` on Classic Event Lambda + HTTP API Gateway; and `examples/bun-http` on a Container Image Function) exposing equivalent application workloads; a platform-reserved health path is not an application workload.
_Avoid_: Handler, Wrapper, Adapter

**Execution Track**:
The hosting regime under which a Candidate Server is measured: a Bare-Process Baseline on the operator host, an emulated Lambda deployment in LocalStack, or a real AWS Lambda deployment. Lambda tracks include Web Functions and both classic Event Function configurations.
_Avoid_: Test Mode, Stage, Environment

**Workload Scenario**:
A standardized HTTP traffic profile exercising a distinct server capability: header/routing micro-overhead, JSON payload serialization, asynchronous I/O multiplexing, chunked response streaming, or CPU-bound event-loop contention.
_Avoid_: Test Case, Endpoint, Route

**Cold-Start Trial**:
A first-application-request measurement after a fresh Revision or classic function configuration replacement, tied to response identity and available platform initialization evidence. It includes network overhead and is not a distribution of naturally occurring cold starts or framework-only initialization time.
_Avoid_: Warm-Up, Framework Init Time

**Capped Cloud Run**:
An AWS measurement with bounded Web Function environment capacity, retaining errors caused by headroom, scaling and account quotas. It measures that constrained service configuration rather than unrestricted runtime capacity.
_Avoid_: Saturation Benchmark, Single-Sandbox Run

**Observed Sandbox Count**:
The number of distinct Execution Environments identified in response evidence during a measurement interval, a lower bound on environments visited rather than simultaneous active capacity. Without identifying evidence the count is unknown.
_Avoid_: Active Environment Count, Concurrent Sandbox Count

**Single-Sandbox Run**:
A warm head-to-head benchmark phase constrained to a single Execution Environment so mid-run sandbox scale-out does not skew per-sandbox framework latency or memory metrics.
_Avoid_: Unbounded Load Test, Scale Test

**Contract Probe**:
A verification test against the Lambda Web Function HTTP and scaling specification—covering header normalization, unsupported HTTP method rejection (`400 Platform.MalformedRequest`), rate throttling (`429 Platform.EndpointRequestThrottle`), and environment-cap throttling (`429 Platform.EndpointMaxEnvThrottle`).
_Avoid_: Unit Test, Smoke Test

**Active CPU Time**:
The processor time actively consumed by the runtime and application while handling requests, excluding wall-clock time spent waiting on non-blocking I/O.
_Avoid_: Wall-Clock Duration, Billed Duration, Elapsed Time

**Telemetry Window**:
A bounded measurement interval bookended by in-sandbox `process.cpuUsage()` and `process.memoryUsage()` snapshots used to attribute Active CPU Time and peak memory to a specific Workload Scenario and concurrency level.
_Avoid_: Log Scrape, CloudWatch Period
