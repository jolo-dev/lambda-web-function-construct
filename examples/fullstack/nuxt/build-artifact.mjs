// Builds Nuxt with Nitro's node-server preset and stages a Web Function artifact root in $ARTIFACT_OUT.
// Run through build-native.sh or build-arm64.sh, which set ARTIFACT_OUT and remove stale output first.
// Stages the complete .output tree and a root launcher; no rebundling.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const out = process.env.ARTIFACT_OUT;
if (!out) throw new Error("ARTIFACT_OUT is not set; run through build-native.sh or build-arm64.sh");

const build = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "nuxt", "bin", "nuxt.mjs"), "build"],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) throw new Error(`nuxt build failed with status ${build.status}`);

const outputDir = path.join(root, ".output");
const serverEntry = path.join(outputDir, "server", "index.mjs");
if (!existsSync(serverEntry)) {
  throw new Error(`nuxt build did not produce ${serverEntry}; check nitro.preset=node-server`);
}
const publicDir = path.join(outputDir, "public");
if (!existsSync(publicDir)) {
  throw new Error(`nuxt build did not produce ${publicDir}`);
}

// Discover the content-hashed asset prefix(es) under .output/public for reporting.
// Nuxt/Nitro typically emits client assets under /_nuxt/.
const publicEntries = readdirSync(publicDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `/${e.name}/`);
console.log(`discovered public subdirectories: ${publicEntries.join(", ") || "(none)"}`);

// The no-op filter keeps Node on cpSync's JS path: copy_file_range is rejected with EACCES
// on Docker Desktop bind mounts used by build-arm64.sh.
cpSync(outputDir, path.join(out, ".output"), { recursive: true, filter: () => true });
rebaseOutputSymlinks(path.join(out, ".output"), outputDir);
repairNitroVueTrace(path.join(out, ".output", "server", "node_modules"));
breakNitroCycles(path.join(out, ".output", "server", "node_modules", ".nitro"));
cpSync(path.join(root, "index.js"), path.join(out, "index.js"), { filter: () => true });
console.log(`staged Nuxt node-server artifact in ${out}`);
console.log(`server entry: .output/server/index.mjs`);

// cpSync preserves absolute symlinks emitted by Nitro's traced .nitro hoisting; those point back into the
// source .output and would be rejected as escaping the artifact root during Web Function packaging. Remap
// any symlink whose target resolves inside the source .output to the equivalent path in the staged .output.
function rebaseOutputSymlinks(stagedOutput, sourceOutput) {
  const stagedReal = realpathSync(stagedOutput);
  const sourceReal = realpathSync(sourceOutput);
  let rebased = 0;
  // Use the canonical root for both sides of path.relative, including through checkout aliases.
  walk(stagedReal, (filePath) => {
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      return;
    }
    if (!stat.isSymbolicLink()) return;
    const linkTarget = readlinkSync(filePath);
    const resolved = path.isAbsolute(linkTarget)
      ? realpathSync.safe ? realpathSync.safe(linkTarget) : safeRealpath(linkTarget)
      : safeRealpath(path.resolve(path.dirname(filePath), linkTarget));
    if (resolved == null) return; // broken links are left for packaging validation to reject with context
    let mapped = null;
    if (resolved === sourceReal || resolved.startsWith(sourceReal + path.sep)) {
      mapped = path.join(stagedReal, path.relative(sourceReal, resolved));
    } else if (resolved === stagedReal || resolved.startsWith(stagedReal + path.sep)) {
      mapped = resolved;
    }
    if (mapped == null) return;
    rmSync(filePath);
    symlinkSync(path.relative(path.dirname(filePath), mapped), filePath);
    rebased++;
  });
  if (rebased > 0) console.log(`rebased ${rebased} Nitro symlink(s) into the staged artifact`);
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      visit(full);
      continue;
    }
    visit(full);
    if (entry.isDirectory()) walk(full, visit);
  }
}

// Nitro 2.x tracing can emit an incomplete traced vue package for one hoisted version while a complete
// sibling version exists under .nitro. If the top-level vue symlink resolves to a package missing the
// node export entry, repoint it to a complete traced vue so the extracted artifact starts.
function repairNitroVueTrace(serverNodeModules) {
  const vueLink = path.join(serverNodeModules, "vue");
  if (!existsSync(vueLink)) return;
  const vueIndex = path.join(vueLink, "index.mjs");
  if (existsSync(vueIndex)) return;
  const nitroDir = path.join(serverNodeModules, ".nitro");
  if (!existsSync(nitroDir)) return;
  const candidates = readdirSync(nitroDir)
    .filter((name) => name.startsWith("vue@"))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const candidatePath = path.join(nitroDir, candidate);
    if (existsSync(path.join(candidatePath, "index.mjs"))) {
      if (lstatSync(vueLink).isSymbolicLink()) rmSync(vueLink);
      else rmSync(vueLink, { recursive: true, force: true });
      symlinkSync(path.join(".nitro", candidate), vueLink);
      console.log(`repaired traced vue symlink -> .nitro/${candidate}`);
      return;
    }
  }
  console.warn(`warning: traced vue package is missing index.mjs and no complete .nitro/vue@* candidate found`);
}

// Nitro's traced .nitro hoisting can contain directory-symlink cycles (peer deps). The Web Function
// packager dereferences symlinks into content and rejects cycles, so break 2-cycles by removing one edge;
// Node resolves the removed peer from higher-level node_modules.
function breakNitroCycles(nitroDir) {
  if (!existsSync(nitroDir)) return;
  const nitroReal = realpathSync(nitroDir);
  const edges = new Map(); // "src\0dst" -> [symlinkPath]
  collectNitroEdges(nitroReal, nitroReal, edges);
  let broken = 0;
  const seen = new Set();
  for (const key of edges.keys()) {
    const [src, dst] = key.split("\0");
    const reverse = `${dst}\0${src}`;
    const pair = [src, dst].sort().join("\0");
    if (src === dst || seen.has(pair) || !edges.has(reverse)) continue;
    seen.add(pair);
    // Remove the edge from the package that is less likely to be the primary provider: prefer to keep
    // links pointing to a package whose name matches the source context; as a deterministic fallback,
    // remove the edge originating from the lexically greater package.
    const removeKey = src > dst ? key : reverse;
    for (const linkPath of edges.get(removeKey) ?? []) {
      try {
        if (lstatSync(linkPath).isSymbolicLink()) {
          rmSync(linkPath);
          broken++;
        }
      } catch {
        // already removed
      }
    }
  }
  if (broken > 0) console.log(`broke ${broken} Nitro symlink cycle edge(s)`);
}

function nitroPackageName(filePath, nitroReal) {
  const rel = path.relative(nitroReal, filePath);
  const parts = rel.split(path.sep);
  if (parts[0]?.startsWith("@") && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? "";
}

function collectNitroEdges(dir, nitroReal, edges) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = safeRealpath(full);
      if (resolved && (resolved === nitroReal || resolved.startsWith(nitroReal + path.sep))) {
        const src = nitroPackageName(full, nitroReal);
        const dst = nitroPackageName(resolved, nitroReal);
        if (src && dst && src !== dst) {
          const key = `${src}\0${dst}`;
          if (!edges.has(key)) edges.set(key, []);
          edges.get(key).push(full);
        }
      }
      continue;
    }
    if (entry.isDirectory()) collectNitroEdges(full, nitroReal, edges);
  }
}
