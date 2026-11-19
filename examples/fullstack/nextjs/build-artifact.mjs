// Builds the Next.js standalone server and stages a Web Function artifact root in $ARTIFACT_OUT.
// Run through build-native.sh or build-arm64.sh, which set ARTIFACT_OUT and remove stale output first.
// Nothing is bundled: the standalone tree keeps Next's own server and its traced node_modules.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const out = process.env.ARTIFACT_OUT;
if (!out) throw new Error("ARTIFACT_OUT is not set; run through build-native.sh or build-arm64.sh");

const build = spawnSync(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error(`next build failed with status ${build.status}`);

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error(`next build did not produce ${path.join(standalone, "server.js")}; check next.config.mjs output`);
}

// The standalone tree carries the server, its manifests and traced dependencies. Next does not copy
// .next/static or public/ into it, so both are staged beside it at the paths the server reads.
// The no-op filter keeps Node on cpSync's JS path: copy_file_range is rejected with EACCES
// on Docker Desktop bind mounts used by build-arm64.sh.
const portableCopy = { recursive: true, filter: () => true };
cpSync(standalone, out, portableCopy);
cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), portableCopy);
cpSync(path.join(root, "public"), path.join(out, "public"), portableCopy);
cpSync(path.join(root, "index.js"), path.join(out, "index.js"), portableCopy);
console.log(`staged Next.js standalone artifact in ${out}`);
