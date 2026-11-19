import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

const square = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (typeof input !== "object" || input === null || !("value" in input)) {
      throw new Error("A number is required");
    }
    const raw = (input as { value: unknown }).value;
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw new Error("Value must be a number from 0 to 1000");
    }
    return value;
  })
  .handler(async ({ data }) => {
    return { result: String(data * data) };
  });

export const Route = createFileRoute("/")({
  loader: () => ({ renderedAt: new Date().toISOString() }),
  component: Home,
});

function Home() {
  const { renderedAt } = Route.useLoaderData();
  const [count, setCount] = useState(0);
  const [value, setValue] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setError(null);
    try {
      const response = await square({ data: { value } });
      setResult(response.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }

  return (
    <main className="aurora-shell">
      <nav aria-label="Primary" className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-2.5 w-8 rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500" />
          <span className="text-sm font-semibold tracking-wide text-indigo-100">
            TanStack Start / Web Function
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm">
          <Link id="about-link" className="aurora-link" to="/about">About</Link>
          <Link className="aurora-link" to="/login">Sign in</Link>
          <Link className="aurora-link" to="/profile">Profile</Link>
        </div>
      </nav>

      <section className="mt-10 lg:grid lg:grid-cols-[1.2fr_0.8fr] gap-8 items-center">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            The whole stack, running live.
          </h1>
          <p className="mt-4 max-w-prose text-base leading-relaxed text-indigo-100/80">
            This page is rendered by a TanStack Start app deployed as a Lambda Web
            Function behind CloudFront. Every request proves the full path:
            server rendering, a server-side mutation, and a secure app session.
          </p>
        </div>
        <aside className="aurora-card">
          <header className="flex items-center justify-between">
            <span className="aurora-label">DEPLOYED PROOF</span>
            <span aria-hidden="true" className="h-2.5 w-8 rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500" />
          </header>
          <dl className="mt-4 flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-indigo-200/80">GET /</dt>
              <dd className="flex items-center gap-2 text-indigo-50">
                <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                200
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-indigo-200/80">SSR</dt>
              <dd>
                <p id="ssr-time" className="text-right text-indigo-50">Rendered on the server at {renderedAt}</p>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-indigo-200/80">app-session</dt>
              <dd className="aurora-ok font-semibold tracking-wide">SECURE</dd>
            </div>
          </dl>
          <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500" />
          </div>
        </aside>
      </section>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <section className="aurora-card-tight">
          <p className="aurora-label">Client counter</p>
          <p id="count" className="mt-2 text-lg font-semibold text-white">Count: {count}</p>
          <button id="increment" type="button" className="aurora-button mt-3" onClick={() => setCount((c) => c + 1)}>
            Increment
          </button>
        </section>
        <section className="aurora-card-tight">
          <p className="aurora-label">Server mutation</p>
          <form id="square-form" className="mt-3 flex flex-col gap-3" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <label htmlFor="value" className="text-sm text-indigo-200/80">Number from 0 to 1000</label>
              <input
                id="value"
                name="value"
                className="aurora-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <button id="square-submit" type="submit" className="aurora-button">Square</button>
          </form>
          {result ? <p id="square-result" className="aurora-ok mt-3 text-sm font-semibold">{result}</p> : null}
          {error ? <p id="square-error" role="alert" className="aurora-warn mt-3 text-sm font-semibold">{error}</p> : null}
        </section>
      </div>
    </main>
  );
}
