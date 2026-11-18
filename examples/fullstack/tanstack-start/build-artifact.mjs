// Builds the TanStack Start production server/client and stages a Web Function artifact root in $ARTIFACT_OUT.
// Run through build-native.sh or build-arm64.sh, which set ARTIFACT_OUT and remove stale output first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.ARTIFACT_OUT
  ? path.resolve(process.env.ARTIFACT_OUT)
  : path.resolve(process.argv[2] ?? path.join(root, "..", "artifacts", "tanstack-start", `native-${process.platform}-${process.arch}`));

const build = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error(`vite build failed with status ${build.status}`);

const distDir = path.join(root, "dist");
const serverEntry = path.join(distDir, "server", "server.js");
const clientAssetsDir = path.join(distDir, "client", "assets");
if (!existsSync(serverEntry)) {
  throw new Error(`Missing TanStack Start server output at ${serverEntry}.`);
}
if (!existsSync(clientAssetsDir)) {
  throw new Error(`Missing TanStack Start client assets at ${clientAssetsDir}.`);
}

mkdirSync(out, { recursive: true });
cpSync(distDir, path.join(out, "dist"), {
  recursive: true,
  dereference: true,
  filter: (source) => !source.includes(`${path.sep}.vite${path.sep}`),
});
cpSync(path.join(root, "index.js"), path.join(out, "index.js"), { dereference: true });

// The server bundle keeps framework/runtime packages external; stage example node_modules
// so the extracted Web Function artifact can resolve them without rebundling.
cpSync(path.join(root, "node_modules"), path.join(out, "node_modules"), {
  recursive: true,
  dereference: true,
  filter: (source) => {
    const rel = path.relative(path.join(root, "node_modules"), source);
    return rel === "" || !rel.split(path.sep).includes(".bin");
  },
});

writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
console.log(`Staged TanStack Start artifact at ${out}`);
