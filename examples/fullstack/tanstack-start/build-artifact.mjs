import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const fullstackDir = path.resolve(exampleDir, "..");
const defaultArtifactDir = path.join(fullstackDir, "artifacts/tanstack-start/native-darwin-arm64");
const artifactDir = path.resolve(process.env.ARTIFACT_OUT ?? process.argv[2] ?? defaultArtifactDir);

const distDir = path.join(exampleDir, "dist");
const serverEntry = path.join(distDir, "server/server.js");
const clientAssetsDir = path.join(distDir, "client/assets");
if (!existsSync(serverEntry)) {
  throw new Error(`Missing TanStack Start server output at ${serverEntry}. Run \`bun run build\` first.`);
}
if (!existsSync(clientAssetsDir)) {
  throw new Error(`Missing TanStack Start client assets at ${clientAssetsDir}. Run \`bun run build\` first.`);
}

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });

cpSync(distDir, path.join(artifactDir, "dist"), {
  recursive: true,
  dereference: true,
  filter: (source) => !source.includes(`${path.sep}.vite${path.sep}`),
});
cpSync(path.join(exampleDir, "index.js"), path.join(artifactDir, "index.js"), { dereference: true });

// The server bundle keeps framework/runtime packages external; stage example node_modules
// so the extracted Web Function artifact can resolve them without rebundling.
cpSync(path.join(exampleDir, "node_modules"), path.join(artifactDir, "node_modules"), {
  recursive: true,
  dereference: true,
});

writeFileSync(
  path.join(artifactDir, "package.json"),
  JSON.stringify({ type: "module", private: true }, null, 2) + "\n",
);

console.log(`Staged TanStack Start artifact at ${artifactDir}`);
