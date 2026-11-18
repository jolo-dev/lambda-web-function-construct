/**
 * CloudFront Functions (JS 2.0) viewer-request source for the Web Function origin.
 * Client-supplied `forwarded` is removed. The viewer Host is copied to a custom `x-public-host`
 * header and `x-forwarded-proto` is set to the HTTPS scheme the distribution enforces.
 *
 * CloudFront Functions cannot add or delete `x-forwarded-host` at runtime (live 502
 * FunctionValidationError: "The CloudFront function tried to add a disallowed header"), so the
 * controlled public origin context travels under `x-public-host`. Frameworks that need the public
 * hostname must read that header and ignore any client-supplied `x-forwarded-host`; none of the three
 * examples currently consume either header. The origin Host remains the Web Function endpoint
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
  request.headers["x-forwarded-proto"] = { value: "https" };
  return request;
}`;
