import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
  const value = body?.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
    return new Response(JSON.stringify({ error: "Value must be a number from 0 to 1000" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify({ result: value * value }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
