import Link from "next/link";
import { Counter } from "./counter";
import { SquareForm } from "./square-form";

// Rendered per request so the server timestamp proves SSR runs on each request, not at build time.
export const dynamic = "force-dynamic";

export default function Home() {
  const renderedAt = new Date().toISOString();
  return (
    <main>
      <h1>Next.js standalone on a Web Function</h1>
      <p>{`Rendered on the server at ${renderedAt}`}</p>
      <Counter />
      <SquareForm />
      <Link href="/about">Go to the about page</Link>
    </main>
  );
}
