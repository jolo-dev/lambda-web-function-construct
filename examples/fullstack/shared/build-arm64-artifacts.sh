#!/usr/bin/env bash
# Builds all three fullstack example artifacts for Linux Arm64 in a pinned Node 24 container.
# Requires a running Docker daemon. This produces deployment-shaped artifacts, not a deployment.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

# Keep in sync with the root mise pin and the framework lockfiles.
readonly BUN_VERSION="1.4.4"
# The host node_modules/ and build outputs are darwin-native; install fresh dependencies in the container.
readonly BUILD_COMMAND="set -e; npm install --prefix /tmp/bun bun@${BUN_VERSION} >/dev/null 2>&1; BUN=/tmp/bun/node_modules/.bin/bun; rm -rf /tmp/build; mkdir -p /tmp/build; cp -a /app/. /tmp/build/; rm -rf /tmp/build/node_modules /tmp/build/.next /tmp/build/.output /tmp/build/dist; cd /tmp/build; \"\$BUN\" install --frozen-lockfile; node build-artifact.mjs"

for framework in nextjs nuxt tanstack-start; do
	echo "==> building linux-arm64 artifact: $framework"
	bash "$script_dir/build-arm64.sh" "$repo_root/examples/fullstack/$framework" -- sh -c "$BUILD_COMMAND"
done

echo "All three Linux Arm64 artifacts were built under $repo_root/examples/fullstack/artifacts/<framework>/linux-arm64."
echo "This is local container evidence only; no AWS deployment has occurred."
