import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// `mode: "local"` makes the adapter export its request handler from
// dist/server/entry.mjs instead of binding process.env.PORT itself, which is
// what lets the launcher own the socket (port 0 support + READY:<port>).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "local" }),
  // Emit the stylesheet as a content-hashed asset under dist/client/_astro instead of
  // inlining it into the HTML head: the Web Function delivery maps /_astro/ to S3, and
  // without an emitted client asset the _astro directory (and that mapping) is empty.
  build: { inlineStylesheets: "never" },
});
