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
    <main>
      <h1>TanStack Start on Lambda Web Function</h1>
      <p id="ssr-time">Rendered on the server at {renderedAt}</p>
      <p>
        <Link id="about-link" to="/about">About</Link>
      </p>
      <section>
        <h2>Client counter</h2>
        <p id="count">Count: {count}</p>
        <button id="increment" type="button" onClick={() => setCount((c) => c + 1)}>
          Increment
        </button>
      </section>
      <section>
        <h2>Server mutation</h2>
        <form id="square-form" onSubmit={submit}>
          <label htmlFor="value">Number</label>
          <input id="value" name="value" value={value} onChange={(e) => setValue(e.target.value)} />
          <button id="square-submit" type="submit">Square</button>
        </form>
        {result ? <p id="square-result">{result}</p> : null}
        {error ? <p id="square-error">{error}</p> : null}
      </section>
    </main>
  );
}
