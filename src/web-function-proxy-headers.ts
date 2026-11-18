/**
 * CloudFront Functions (JS 2.0) viewer-request source for the Web Function origin.
 * Client-supplied forwarding headers are never trusted: they are replaced with the viewer's
 * Host and the HTTPS scheme that the distribution enforces for every viewer.
 */
export const proxyHeadersFunctionCode = `function handler(event) {
  var request = event.request;
  var host = request.headers.host;
  if (!host) {
    return { statusCode: 400, statusDescription: "Bad Request" };
  }
  request.headers["x-forwarded-host"] = { value: host.value };
  request.headers["x-forwarded-proto"] = { value: "https" };
  return request;
}`;
