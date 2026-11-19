import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main className="aurora-shell">
      <section className="aurora-card mx-auto w-full max-w-md">
        <p className="aurora-label">EXAMPLE</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">About this example</h1>
        <p id="about-text" className="mt-4 text-base leading-relaxed text-indigo-100/80">
          This page proves TanStack Start navigation and hydration work on a Web Function.
        </p>
        <p className="mt-6 text-sm">
          <Link className="aurora-link" to="/">Home</Link>
        </p>
      </section>
    </main>
  );
}
