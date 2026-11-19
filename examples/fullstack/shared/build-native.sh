#!/usr/bin/env bash
# Native host build for rapid iteration. Its output is NOT Linux Arm64 deployment evidence.
#
# Usage: build-native.sh <workspace-dir> -- <command> [args...]
#
# The command runs in the workspace with $ARTIFACT_OUT set to examples/fullstack/artifacts/<workspace>/native-<platform>-<arch>.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

die() {
	echo "error: $*" >&2
	exit 1
}

usage() {
	echo "usage: build-native.sh <workspace-dir> -- <command> [args...]" >&2
	exit 2
}

[[ $# -ge 3 && "$2" == "--" ]] || usage
workspace="$(cd "$1" 2>/dev/null && pwd)" || die "workspace not found: $1"
shift 2

command -v node >/dev/null 2>&1 || die "node is not on PATH"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == "24" ]] || die "Node.js 24 is required, found $(node -v)"
host_target="$(node -p "process.platform + '-' + process.arch")"

artifact_root="$repo_root/examples/fullstack/artifacts/$(basename "$workspace")/native-$host_target"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"

(cd "$workspace" && ARTIFACT_OUT="$artifact_root" "$@")

[[ -n "$(ls -A "$artifact_root")" ]] || die "build produced no output in $artifact_root"
echo "artifact: $artifact_root (native $host_target, development only; not Linux Arm64 evidence)"
