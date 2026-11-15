# Cognito-protected Web Function backends

Three independent backend examples for a **separate browser frontend**:

- [`hono/app.ts`](hono/app.ts) — Hono middleware and typed request context.
- [`express/app.ts`](express/app.ts) — Express middleware and request-local identity.
- [`node-http/app.ts`](node-http/app.ts) — native Node.js HTTP routing.

No Amplify, Better Auth, API Gateway, Identity Pool, or browser client secret is required. Each example uses the optional `cognito` construct parameter and verifies Cognito **access tokens** with `aws-jwt-verify`.

These examples are separate from the public benchmark applications. Deploying them does not change the benchmark stacks.

## OIDC flow

See **[the numbered OIDC + PKCE flow](OIDC_FLOW.md)** for the editable diagram and the complete frontend-to-Cognito-to-backend request sequence. It distinguishes the frontend login integration from the bearer-token verification implemented in these examples, including JWKS caching, CORS preflight, and authorization failures.

## Request contract

| Route | Authentication | Response |
|---|---|---|
| `GET /healthz` | Public | `{ "ok": true }` |
| `GET /me` | Valid access token | `{ "userId": "<verified sub>", "groups": [] }` |
| `GET /admin` | Valid access token with `admins` group | `{ "userId": "<verified sub>", "message": "Admin access granted" }` |
| `OPTIONS /*` | No token; permitted frontend origin/method/headers required | `204`, or `403` for a denied preflight |

Send `Authorization: Bearer <access_token>`. Missing, malformed, expired, forged, wrong-pool, wrong-client, or ID tokens receive `401`. A verified non-admin receives `403` from `/admin`. API responses use `Cache-Control: no-store`.

## Install and synthesize

From the repository root, using the pinned mise toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun install --cwd examples --frozen-lockfile
mise exec -- bun run build
mise exec -- bun run test:types:cognito
mise exec -- bun test test/cognito-auth.test.ts test/cognito-construct.test.ts test/cognito-examples.test.ts
```

Synthesize all three stacks without deploying resources (substitute your account/Region):

```sh
CDK_DEFAULT_ACCOUNT=123456789012 CDK_DEFAULT_REGION=eu-central-1 \
  bunx cdk synth --all --app 'bun run examples/cognito/cdk-app.ts' \
  --output cdk.out.cognito
```

The default frontend is `http://localhost:5173`, callback is `/auth/callback`, and logout returns to `/`. For a hosted frontend, pass exact HTTPS values:

```sh
bunx cdk synth --all --app 'bun run examples/cognito/cdk-app.ts' \
  --output cdk.out.cognito \
  -c frontendOrigin=https://app.example.com \
  -c callbackUrl=https://app.example.com/auth/callback \
  -c logoutUrl=https://app.example.com/
```

Each stack gets its own pool/client/domain. Domain prefixes default to `webfn-<account>-<region>-<framework>`. Override with `-c domainPrefix=my-unique-prefix`; the framework suffix is appended. A prefix must be available in Cognito. The separate `frontendOrigin` value must contain only scheme/host/optional port, **without a trailing slash or path**.

## Deploy one backend

Authenticate to AWS, select your profile/Region, and review the diff first. These commands create billable AWS resources:

```sh
AWS_REGION=eu-central-1 bunx cdk diff Cognito-hono --profile YOUR_PROFILE \
  --app 'bun run examples/cognito/cdk-app.ts' --output cdk.out.cognito \
  --no-change-set

AWS_REGION=eu-central-1 bunx cdk deploy Cognito-hono --profile YOUR_PROFILE \
  --app 'bun run examples/cognito/cdk-app.ts' --output cdk.out.cognito \
  --outputs-file cdk.out.cognito/outputs.json
```

Use `Cognito-express` or `Cognito-node-http` to select another example. Include the same `-c` frontend/callback/logout options in **every** synth/diff/deploy/destroy command when overriding defaults.

Outputs include:

- `CognitoUserPoolId`: user pool ID.
- `CognitoClientId`: public app client ID.
- `CognitoLoginDomain`: HTTPS Cognito managed-login origin.
- `CognitoIssuer`: OIDC issuer URL; append `/.well-known/openid-configuration` for discovery.
- `webFunctionEndpointUrl`: backend domain name; prefix with `https://` when calling it.

CDK appends logical-ID suffixes to output keys. The pool/client IDs are also injected into the revision as `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`; `FRONTEND_ORIGIN` configures the example's exact CORS allowlist.

## Create a test user

The construct disables public self-sign-up and requires software TOTP MFA. Invite a user through the Cognito console, or use the CLI with your selected profile and Region:

```sh
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_POOL_ID \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com \
  --desired-delivery-mediums EMAIL \
  --profile YOUR_PROFILE --region eu-central-1
```

Cognito delivers a temporary password. Complete the password-change and authenticator enrollment steps during managed login. Do not commit passwords, tokens, or authenticator secrets. This invitation does not itself establish email verification; complete Cognito's email-verification flow before relying on email for recovery or identity checks. Adjust Cognito email delivery configuration/quotas for production.

To exercise group-based authorization, create the group and add your user:

```sh
aws cognito-idp create-group --user-pool-id YOUR_POOL_ID --group-name admins \
  --profile YOUR_PROFILE --region eu-central-1
aws cognito-idp admin-add-user-to-group --user-pool-id YOUR_POOL_ID \
  --username you@example.com --group-name admins \
  --profile YOUR_PROFILE --region eu-central-1
```

Sign in again or refresh tokens after changing group membership. Existing access tokens retain their old claims until expiration.

## Connect the separate frontend

Use standard **authorization code flow with PKCE S256**, either with your frontend's OIDC library or native browser APIs. The app client has **no secret**.

1. Generate cryptographically random, single-use `state`, `nonce`, and PKCE verifier values. Bind them to the browser login transaction, with a short expiry.
2. Calculate `code_challenge = base64url(SHA256(code_verifier))` using Web Crypto.
3. Navigate to `<CognitoLoginDomain>/oauth2/authorize` with `response_type=code`, `client_id`, the exact registered `redirect_uri`, `scope=openid profile email`, `state`, `nonce`, `code_challenge`, and `code_challenge_method=S256`.
4. At your frontend callback, validate `state` (including error callbacks), handle OAuth errors, and consume the transaction once. Exchange the returned code promptly at `<CognitoLoginDomain>/oauth2/token` using `fetch()` and an `application/x-www-form-urlencoded` POST containing `grant_type=authorization_code`, `client_id`, `redirect_uri`, `code`, and the saved `code_verifier`. No client secret is sent.
5. Validate the ID token according to OIDC, including issuer, audience, signature, expiration, and nonce, before using its identity claims. Do not substitute an ID token for an API access token.
6. Keep tokens out of URLs and logs; remove callback query parameters after processing. Prefer keeping access tokens in memory and avoid persistent browser refresh-token storage for high-value apps. Refresh through Cognito's token endpoint; refresh-token rotation is enabled, so replace the saved refresh token when Cognito returns a new one.
7. Call the backend using the **access token**:

```ts
const response = await fetch(`${backendOrigin}/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (response.status === 401) {
  // Refresh once, or require sign-in again. Do not retry indefinitely.
}
```

Native implementations must also handle replay protection, refresh concurrency, callback errors, expiry, and logout. Cognito's managed-login logout endpoint is `<CognitoLoginDomain>/logout?client_id=...&logout_uri=...`, with an exact registered logout URL. Clear local tokens too; hosted-login logout does not invalidate every already-issued access token.

## Run a backend locally

Use real pool/client identifiers from one deployed stack:

```sh
COGNITO_USER_POOL_ID=YOUR_POOL_ID \
COGNITO_CLIENT_ID=YOUR_CLIENT_ID \
FRONTEND_ORIGIN=http://localhost:5173 \
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 \
  bun run examples/cognito/hono/index.ts
```

Change `hono` to `express` or `node-http` as needed. On AWS the Web Function platform sets `AWS_LAMBDA_HTTP_ENDPOINT`; locally the default is `127.0.0.1:3000`. Missing auth/CORS configuration stops startup rather than serving an unprotected API.

```sh
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/me   # 401
# ACCESS_TOKEN must be a valid Cognito access token; don't paste it into shared logs.
curl -i http://127.0.0.1:3000/me -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Security and operational boundaries

- `cognito` provisions infrastructure and verifier identifiers. It **does not** install middleware into arbitrary application code. `APPLICATION_MANAGED` still requires application authentication on every protected route.
- CORS is not authentication and does not prevent direct non-browser requests. These APIs use bearer tokens, not cookies, so credentialed CORS is unnecessary.
- The shared verifier is created once, uses cached Cognito JWKS, handles signing-key rotation, and requires valid signature, issuer, expiry, `client_id`, and `token_use=access`. Public JWKS retrieval requires outbound HTTPS; no Cognito IAM permissions are required for it.
- User identity comes from verified `sub`, never a request parameter. Add resource-ownership/tenant checks before returning application data. The `admins` check is an example, not a complete authorization model.
- Access/ID tokens last 10 minutes, refresh tokens 7 days. Token revocation and rotation are enabled. Local JWT verification does not check a live revocation list: disabled users or revoked sessions can retain access until token expiry. Add server-side checks if immediate revocation is required.
- The pool uses the **Essentials** feature plan, managed login v2 with per-client default branding, required TOTP MFA, and a 12-character password policy. Review current Cognito pricing before deployment. Customize exposed resources deliberately for your production requirements.
- Each example caps environments at two and request rate at 50/second. Unauthenticated traffic still reaches application code and can incur charges. Review limits and add an appropriate edge protection strategy before public production use.
- Tokens are verified offline in tests with generated local RSA keys and preloaded JWKS; no AWS credentials or network calls are needed for those tests.

## Cleanup

```sh
AWS_REGION=eu-central-1 bunx cdk destroy Cognito-hono --profile YOUR_PROFILE \
  --app 'bun run examples/cognito/cdk-app.ts' --output cdk.out.cognito
```

**User pools are retained to protect user accounts.** Stack removal deletes stack-managed clients/domains but leaves the pool. Inspect retained pools and log groups separately; delete them manually only when you intend to remove the data. Removing `cognito` from an existing construct also retains its pool and removes its managed clients/domain. Omitting the option on a new construct creates no Cognito resources.

References: [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html), [JWT verification](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html).
