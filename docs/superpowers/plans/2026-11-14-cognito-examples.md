# Optional Cognito and Authenticated Examples Implementation Plan

**Goal:** Add opt-in Cognito provisioning to WebFunction and separate Hono, Express, and Node HTTP bearer-authentication examples without changing benchmark deployments.

**Architecture:** An optional `cognito` property provisions a retained User Pool, public OAuth code client, managed-login domain and branding. The construct injects pool/client identifiers; application code verifies access tokens. Examples share JWT verification and exact-origin CORS policy, but demonstrate native routing in each framework.

**Tech stack:** AWS CDK/JSII, Cognito, Bun tests, aws-jwt-verify, Node.js 24, Hono, Express.

## Tasks

- [x] Add failing synthesis/type tests for optional Cognito resources, public OAuth client, environment injection, outputs, validation, and unchanged default behavior.
- [x] Implement/export Cognito configuration and optional resources in `src/web-function.ts` and `src/index.ts`; build and run focused tests.
- [x] Add `aws-jwt-verify` only to `examples/package.json` and update its lockfile.
- [x] Add failing tests for real RSA-signed JWT verification (cached local JWKS), all three HTTP apps, protected identity/admin routes, and browser preflight behavior.
- [x] Implement shared authentication/CORS helpers and independently runnable `examples/cognito/{hono,express,node-http}` applications.
- [x] Add a dedicated CDK app and example stacks with configurable callback/logout/frontend origins; test synthesis separately from benchmarks.
- [x] Document deployment, account provisioning, PKCE frontend login and API calls, security boundaries, and cleanup in the example README and root README.
- [x] Run JSII build, compile-time tests, example type checks, full Bun suite, CDK synth for all three new stacks, and diff review. Do not deploy or commit without a user request.

## Acceptance checks

- Omitting `cognito` creates no Cognito resources and preserves existing environment variables.
- Cognito config rejects IAM authentication, invalid callback/logout URLs, empty callbacks, and reserved environment overrides before bundling.
- Client has no secret, no implicit flow, short access/ID lifetimes, rotation/revocation, and exact callbacks. Managed login v2 includes per-client branding.
- Pool requires TOTP MFA, disables public self-sign-up, and is retained on stack deletion.
- `/healthz` is public, `/me` requires a verified Cognito access token, `/admin` requires the `admins` group. Invalid requests return 401/403 without exposing token details.
- Only configured frontend origin receives CORS permission; OPTIONS does not require authentication. No cookies, Amplify, Better Auth, or browser client secrets.
- Tests use local signing keys and cached JWKS; no credentials or network are needed for authentication tests.
