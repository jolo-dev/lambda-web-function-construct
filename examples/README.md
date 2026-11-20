# Examples

Runnable examples for the Lambda Web Function construct. Each directory is
self-contained with its own dependencies and README.

| Directory | What it shows |
| --- | --- |
| [`node-http/`](node-http/) | `node:http` server on a Lambda Web Function |
| [`express/`](express/) | Express on a Lambda Web Function |
| [`hono/`](hono/) | Hono on a Lambda Web Function |
| [`h3/`](h3/) | h3 on a Lambda Web Function |
| [`lambda-apigw/`](lambda-apigw/) | Classic Event Lambda + HTTP API Gateway (v2) comparison |
| [`bun-http/`](bun-http/) | `Bun.serve` on a Lambda Container Image + Function URL |
| [`cognito/`](cognito/README.md) | Cognito-protected Hono/Express/Node HTTP backends + [OIDC flow](cognito/OIDC_FLOW.md) |
| [`fullstack/`](fullstack/) | Next.js, Astro, Nuxt, and TanStack Start deployed through the framework constructs |
| [`benchmark/`](benchmark/README.md) | Load generator, benchmark runners, and result reports |
| [`shared/`](shared/) | Workload definitions shared by the server examples |

The first six are the benchmark Candidate Servers (see
[benchmark/README.md](benchmark/README.md)); the fullstack examples are local proofs
for the framework constructs, not benchmark candidates.
