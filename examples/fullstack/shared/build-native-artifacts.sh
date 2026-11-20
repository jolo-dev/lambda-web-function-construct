#!/usr/bin/env bash
# Build the host-native artifacts required by the fullstack smoke tests.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
for framework in astro nextjs nuxt tanstack-start; do
	(
		cd "$framework"
		bun install --frozen-lockfile
		bun run build:artifact
	)
done
