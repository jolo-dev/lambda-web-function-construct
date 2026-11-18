# Retained live resources (operator request)

**Do not destroy these until the operator asks.** This file records a live Nuxt Web Function rollout that was intentionally **not cleaned up** so the deployment can be inspected.

## FullstackNuxt (retained)

| Item | Value |
| --- | --- |
| AWS profile / account / region | `jolo` / `246350246460` / `eu-central-1` |
| CloudFormation stack | `FullstackNuxt` — `CREATE_COMPLETE` |
| Stack ARN | `arn:aws:cloudformation:eu-central-1:246350246460:stack/FullstackNuxt/02896620-e394-11f1-bd96-0affdc2e5557` |
| CloudFront HTTPS URL | `https://d3d631mv731ey1.cloudfront.net` |
| CloudFront distribution ID | `E2GGYCE0CPDU1S` (`Deployed`) |
| Web Function endpoint | `https://ml9d6vhqg609yml4.h73.lambda-web.eu-central-1.on.aws` (direct unsigned access returns 403) |
| Web Function ARN | `arn:aws:lambda:eu-central-1:246350246460:web-function/fullstack-nuxt` |
| Code bucket | `fullstacknuxt-appappwebfunctioncodebucket977693d3-5k6zzdibxv9k` |
| Delivery asset bucket | `fullstacknuxt-deliveryassetbucket87363ba9-yfox4ireritf` (private, S3 OAC; removal policy DESTROY) |
| Cache policy | 1 second min/default/max TTL; cache key = `Authorization` + all cookies + all query strings |

CDK bootstrap asset objects uploaded for this deployment (not stack resources; they remain in the bootstrap bucket):

- `81a6c5a59a710993bfdefd04a0343edaba5ee2e0cd6ec6a1ccf644ec21121cec.zip` (75 KB static asset ZIP)
- `b723860ab8ce080849bbede2c933a2f645857e947b8900415f62abad0a178c17.zip` (3.5 MB revision ZIP)
- `a4f4e31eab8af080544e31f30f45a6162c7b9afde52e490514421f491e878a5c.json` (32 KB template)

## Bounded live checks already performed

Unsigned direct endpoint 403; SSR `/` 200 with request-time timestamp; `/about` 200; `/__probe/identity` 404 without marker; `/robots.txt` 200 `text/plain; charset=utf-8`; hashed `/_nuxt/Dk7r3ghq.js` 200 `text/javascript` with `max-age=31536000, immutable`; 404 error path; native `/api/square` valid `{"result":"7 squared is 49"}` and invalid 400 with server-side validation. Cache-key behavior: distinct Authorization/cookie/query combinations each Miss; exact repeat Miss → Hit within 1 second.

Not verified: browser hydration/click navigation, streaming timing, and two-build old-asset retention.

## Ongoing cost / exposure

The distribution, private buckets, Web Function endpoint/revision, log groups, and asset-deployment custom resources are live and billable. The endpoint is network-public but unsigned direct invocation is rejected. Avoid sustained traffic or benchmarks against it.

## Inspect

```sh
AWS_PROFILE=jolo AWS_REGION=eu-central-1 aws cloudformation describe-stacks --stack-name FullstackNuxt
AWS_PROFILE=jolo AWS_REGION=eu-central-1 aws cloudfront get-distribution --id E2GGYCE0CPDU1S
curl -i https://d3d631mv731ey1.cloudfront.net/
curl -i -H 'content-type: application/json' -d '{"value":"12"}' https://d3d631mv731ey1.cloudfront.net/api/square
```

## Cleanup (only when the operator approves)

```sh
cd /Users/jolo/Development/lambda-web-function-construct/.worktrees/fullstack-framework-examples
AWS_PROFILE=jolo AWS_REGION=eu-central-1 \
CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \
bunx cdk destroy FullstackNuxt --app 'bun run examples/fullstack/cdk-app.ts' --force

# Then optionally remove the three bootstrap asset objects listed above:
for k in 81a6c5a59a710993bfdefd04a0343edaba5ee2e0cd6ec6a1ccf644ec21121cec.zip \
         b723860ab8ce080849bbede2c933a2f645857e947b8900415f62abad0a178c17.zip \
         a4f4e31eab8af080544e31f30f45a6162c7b9afde52e490514421f491e878a5c.json; do
  AWS_PROFILE=jolo AWS_REGION=eu-central-1 aws s3api delete-object \
    --bucket cdk-hnb659fds-assets-246350246460-eu-central-1 --key "$k"
done
```
