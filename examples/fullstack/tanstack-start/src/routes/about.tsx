import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main>
      <h1>About this example</h1>
      <p id="about-text">This page proves TanStack Start navigation and hydration work on a Web Function.</p>
      <p><Link to="/">Home</Link></p>
    </main>
  );
}
