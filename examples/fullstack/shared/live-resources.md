# Retired live resources (Nuxt)

**Status: DELETED (2026-11-18).** The operator tested the retained Nuxt deployment and then asked for cleanup. The stack, distribution, buckets, Web Function resources, and the bootstrap asset objects from this deployment were all deleted and verified gone. No live AWS resources from this work remain.

## Deployment that was retired

| Item | Former value |
| --- | --- |
| AWS profile / account / region | `jolo` / `246350246460` / `eu-central-1` |
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

## Bounded live checks performed before deletion

Unsigned direct endpoint 403; SSR `/` 200 with request-time timestamp; `/about` 200; `/__probe/identity` 404 without marker; `/robots.txt` 200 `text/plain; charset=utf-8`; hashed `/_nuxt/Dk7r3ghq.js` 200 `text/javascript` with `max-age=31536000, immutable`; 404 error path; native `/api/square` valid `{"result":"7 squared is 49"}` and invalid 400 with server-side validation. Cache-key behavior: distinct Authorization/cookie/query combinations each Miss; exact repeat Miss → Hit within 1 second.

Not verified: browser hydration/click navigation, streaming timing, and two-build old-asset retention.

## Cleanup verification performed

```text
cdk destroy FullstackNuxt --force   → ✅ destroyed
describe-stacks FullstackNuxt       → stack does not exist
get-distribution E2GGYCE0CPDU1S     → distribution does not exist
list-buckets fullstacknuxt*         → []
bootstrap asset objects listed above → deleted, no objects matching that deployment remain
```
