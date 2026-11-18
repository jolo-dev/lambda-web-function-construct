export const dynamic = "force-dynamic";

/**
 * Smoke-test identity for the shared probe harness. Without FULLSTACK_PROBE_MARKER (every deployed Lambda
 * invocation) the route answers 404, so no identity is exposed outside the local probe.
 */
export function GET() {
  const marker = process.env.FULLSTACK_PROBE_MARKER;
  if (!marker) return new Response("Not Found", { status: 404 });
  return Response.json({ marker, port: Number(process.env.PORT) });
}
