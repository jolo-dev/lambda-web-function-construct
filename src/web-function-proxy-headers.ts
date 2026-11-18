/**
 * CloudFront Functions (JS 2.0) viewer-request source for the Web Function origin.
 * Client-supplied `forwarded` is removed. The viewer Host and the enforced HTTPS scheme are copied
 * to custom `x-public-host` and `x-public-proto` headers.
 *
 * CloudFront Functions reject adding (or deleting) `x-forwarded-*` headers at runtime with a 502
 * FunctionValidationError, "The CloudFront function tried to add a disallowed header" (verified
 * live for both `x-forwarded-host` and `x-forwarded-proto` on 2026-11-18). The controlled public
 * origin context therefore travels under custom headers. Frameworks that need it must read
 * `x-public-host`/`x-public-proto` and ignore any client-supplied `x-forwarded-*` values; none of
 * the three examples currently consume them. The origin Host remains the Web Function endpoint
 * hostname as required by the service.
 *
 * Limitation: CloudFront appends the viewer address to `x-forwarded-for` and cannot strip the
 * client-supplied value. Applications must trust only the rightmost, CloudFront-appended value.
 */
export const proxyHeadersFunctionCode = `function handler(event) {
  var request = event.request;
  var host = request.headers.host;
  if (!host) {
    return { statusCode: 400, statusDescription: "Bad Request" };
  }
  delete request.headers["forwarded"];
  request.headers["x-public-host"] = { value: host.value };
  request.headers["x-public-proto"] = { value: "https" };
  return request;
}`;
