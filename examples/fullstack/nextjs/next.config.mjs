/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Trace dependencies from this example only; a parent lockfile in the repository must not widen the artifact.
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  async rewrites() {
    // The probe harness requests /__probe/identity. Next treats underscore-prefixed folders as private, so the route lives under probe/.
    return [{ source: "/__probe/identity", destination: "/probe/identity" }];
  },
};

export default nextConfig;
