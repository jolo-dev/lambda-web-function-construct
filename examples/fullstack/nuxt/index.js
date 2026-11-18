"use strict";

// Web Function launcher for Nitro node-server output. Lambda starts this file with AWS_LAMBDA_HTTP_ENDPOINT
// set to the host:port to bind. Nitro reads HOST/PORT (and NITRO_HOST/NITRO_PORT) when the built server
// entry is imported, so they are set before the import. Local runs without the variable use 127.0.0.1:3000.

const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LOCAL_FALLBACK_ENDPOINT = "127.0.0.1:3000";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 50;

function parseEndpoint(raw) {
  const match = /^(\[[0-9A-Fa-f:]+\]|[^\s:]+):(\d{1,5})$/.exec(raw);
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `AWS_LAMBDA_HTTP_ENDPOINT must be host:port with a port from 1 to 65535, got "${raw}"`,
    );
  }
  return { host: match[1].replace(/^\[(.*)\]$/, "$1"), port };
}

function waitForListener({ host, port }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`nothing accepted connections on ${host}:${port} within ${READY_TIMEOUT_MS}ms`));
        } else {
          setTimeout(attempt, READY_POLL_MS);
        }
      });
    };
    attempt();
  });
}

async function main() {
  const endpoint = parseEndpoint(process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? LOCAL_FALLBACK_ENDPOINT);
  process.env.HOST = endpoint.host;
  process.env.PORT = String(endpoint.port);
  process.env.NITRO_HOST = endpoint.host;
  process.env.NITRO_PORT = String(endpoint.port);
  // Nitro node-server builds to .output/server/index.mjs; import after env is set so it binds correctly.
  await import(pathToFileURL(path.join(__dirname, ".output", "server", "index.mjs")).href);
  await waitForListener(endpoint);
  process.stdout.write(`READY:${endpoint.port}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
