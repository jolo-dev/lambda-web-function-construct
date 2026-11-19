# Live resources

## FullstackTanStackStart — RETAINED (operator wants to view the page)

**Do not destroy this stack until the operator asks.** Redeployed on 2026-11-19 after the earlier bounded rollout was cleaned up prematurely. This deployment is intentionally left running.

| Item | Value |
| --- | --- |
| CloudFront HTTPS URL (open this) | **https://d29nqdx0jywl18.cloudfront.net** |
| CloudFront distribution ID | `E1IRHI8IPI9MV7` (`Deployed`) |
| Web Function endpoint | `https://t3lhsldkbxxhkqcs.h73.lambda-web.eu-central-1.on.aws` (direct unsigned access 403) |
| AWS profile / account / region | `jolo` / `246350246460` / `eu-central-1` |
| CloudFormation stack | `FullstackTanStackStart` — `CREATE_COMPLETE` |
| Stack ARN | `arn:aws:cloudformation:eu-central-1:246350246460:stack/FullstackTanStackStart/d2982690-e3f7-11f1-8a37-02ffd081c76d` |
| Code bucket | `fullstacktanstackstart-appappwebfunctioncodebucket-ttzbykk1wktl` |
| Delivery asset bucket | `fullstacktanstackstart-deliveryassetbucket87363ba9-gxbcmmdoaotl` |

Public demo login (from the upstream starter): **`demo@example.com` / `demo-password`**. `/login` shows both values. Protected page: `/profile`. The session cookie is `app-session` (HttpOnly, Secure, SameSite=Lax, 7-day TTL). The session secret was generated in the shell for the deploy and is intentionally **not** recorded here.

Verified after this redeploy: `/` 200 with request-time SSR timestamp; `/login` 200 with credentials; invalid login 401 with no Set-Cookie; valid login 200 with `app-session` cookie; `/api/session` returns `{"email":"demo@example.com"}`; authenticated `/profile` shows the email; unauthenticated `/profile` renders the login UI (currently HTTP 500 via the route error boundary — known demo limitation); unsigned direct endpoint 403.

CDK bootstrap asset objects from this retained deployment (leave in place while the stack exists):

- `6f81845881d79915d54000d4a8a90c4222a9bb14b8334ea22d9f50063450fefc.zip` (33 MB revision ZIP)
- `ba8992f9e1046d175a0497915ce7694731ed7d615022092c389813ad0da0db2e.zip` (109 KB static asset ZIP)
- `7fdcaa866d139ff7055cb519b371c5df5c106baabc4e7d854fb3169cb0345dae.json` (32 KB template)

Ongoing cost: CloudFront distribution/requests, S3 buckets, Web Function endpoint/revision, logs, and asset-deployment resources. Avoid sustained traffic or benchmarks.

Cleanup command for later (the throwaway secret is needed because the shared CDK app gates all stacks on `FULLSTACK_SESSION_PASSWORD`):

```sh
FULLSTACK_SESSION_PASSWORD='throwaway-value-at-least-32-characters' \
AWS_PROFILE=jolo AWS_REGION=eu-central-1 \
CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \
bunx cdk destroy FullstackTanStackStart \
  --app 'bun run examples/fullstack/cdk-app.ts' --force
```

---

## FullstackNuxt — RETIRED / DELETED (2026-11-18)

The operator tested the retained Nuxt deployment and then asked for cleanup. Its stack, distribution, buckets, Web Function resources, and bootstrap asset objects were all deleted and verified gone.

| Item | Former value |
| --- | --- |
| CloudFormation stack | `FullstackNuxt` — was `CREATE_COMPLETE` |
| Stack ARN | `arn:aws:cloudformation:eu-central-1:246350246460:stack/FullstackNuxt/02896620-e394-11f1-bd96-0affdc2e5557` |
| CloudFront HTTPS URL | `https://d3d631mv731ey1.cloudfront.net` |
| CloudFront distribution ID | `E2GGYCE0CPDU1S` |
| Web Function endpoint | `https://ml9d6vhqg609yml4.h73.lambda-web.eu-central-1.on.aws` |
| Web Function ARN | `arn:aws:lambda:eu-central-1:246350246460:web-function/fullstack-nuxt` |
| Code bucket | `fullstacknuxt-appappwebfunctioncodebucket977693d3-5k6zzdibxv9k` |
| Delivery asset bucket | `fullstacknuxt-deliveryassetbucket87363ba9-yfox4ireritf` |

Bootstrap asset objects deleted along with the stack:

- `81a6c5a59a710993bfdefd04a0343edaba5ee2e0cd6ec6a1ccf644ec21121cec.zip`
- `b723860ab8ce080849bbede2c933a2f645857e947b8900415f62abad0a178c17.zip`
- `a4f4e31eab8af080544e31f30f45a6162c7b9afde52e490514421f491e878a5c.json`

Cleanup verification performed: `cdk destroy` succeeded; `describe-stacks` → stack does not exist; `get-distribution E2GGYCE0CPDU1S` → distribution does not exist; no `fullstacknuxt*` buckets; bootstrap objects gone.
