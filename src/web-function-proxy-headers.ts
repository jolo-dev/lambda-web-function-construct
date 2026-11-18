/**
 * CloudFront Functions (JS 2.0) viewer-request source for the Web Function origin.
 * Client-supplied forwarding headers are never trusted: `forwarded` is removed, and
 * `x-forwarded-host` and `x-forwarded-proto` are replaced with the viewer's Host and the HTTPS
 * scheme that the distribution enforces for every viewer.
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
  request.headers["x-forwarded-host"] = { value: host.value };
  request.headers["x-forwarded-proto"] = { value: "https" };
  return request;
}`;
