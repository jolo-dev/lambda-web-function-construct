import type { Server } from "node:http";

/** Web Functions provide the listen address through AWS_LAMBDA_HTTP_ENDPOINT. */
export function startServer(server: Server): void {
  const address = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "127.0.0.1:3000";
  const separator = address.lastIndexOf(":");
  const host = separator < 0 ? "127.0.0.1" : address.slice(0, separator);
  const port = Number(separator < 0 ? address : address.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid HTTP listen port");
  server.listen(port, host);
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
