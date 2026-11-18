#!/usr/bin/env bash
# Builds a fullstack framework artifact inside a Linux Arm64 Node.js 24 container.
#
# Usage: build-arm64.sh <workspace-dir> -- <command> [args...]
#
# The command runs in /app (the mounted workspace) and must write its deployable tree to
# $ARTIFACT_OUT (/out, mounted from examples/fullstack/artifacts/<workspace>/linux-arm64).
# Docker is only a build tool. The Web Function runtime is managed Lambda Node.js 24 on Linux Arm64.
# This script never falls back to a native build; use build-native.sh for host iteration.
set -euo pipefail

# TODO: pin the digest of NODE_IMAGE_TAG after verifying it against the registry. It was not
# verifiable offline, so no digest is invented here. The script refuses to run until this is set.
readonly NODE_IMAGE_TAG="node:24.22.1-bookworm-slim"
readonly NODE_IMAGE="${NODE_IMAGE_TAG}@sha256:TODO-pin-verified-digest"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

die() {
	echo "error: $*" >&2
	exit 1
}

usage() {
	echo "usage: build-arm64.sh <workspace-dir> -- <command> [args...]" >&2
	exit 2
}

[[ $# -ge 3 && "$2" == "--" ]] || usage
workspace="$(cd "$1" 2>/dev/null && pwd)" || die "workspace not found: $1"
shift 2

if ! command -v docker >/dev/null 2>&1; then
	die "Docker is unavailable: the docker CLI is not on PATH. build-arm64.sh does not fall back to a native build."
fi
if ! docker_info_error="$(docker info 2>&1 >/dev/null)"; then
	die "Docker is unavailable: 'docker info' failed: $(printf '%s\n' "$docker_info_error" | head -n 1). Start Docker and retry; build-arm64.sh does not fall back to a native build."
fi

if [[ "$NODE_IMAGE" == *TODO* ]]; then
	die "NODE_IMAGE digest is not pinned; set the verified digest for $NODE_IMAGE_TAG in build-arm64.sh before building"
fi

platform="$(docker run --rm --platform linux/arm64 "$NODE_IMAGE" node -p 'process.platform + "/" + process.arch')" ||
	die "could not run the Node.js image for the platform check"
[[ "$platform" == "linux/arm64" ]] || die "container reports '$platform', expected linux/arm64"

artifact_root="$repo_root/examples/fullstack/artifacts/$(basename "$workspace")/linux-arm64"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"

docker run --rm \
	--platform linux/arm64 \
	--user "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e ARTIFACT_OUT=/out \
	-v "$workspace:/app" \
	-v "$artifact_root:/out" \
	-w /app \
	"$NODE_IMAGE" \
	"$@"

[[ -n "$(ls -A "$artifact_root")" ]] || die "build produced no output in $artifact_root"
echo "artifact: $artifact_root (verified container platform: $platform)"
