import Link from "next/link";

export default function About() {
  return (
    <main>
      <h1>About this example</h1>
      <p>A second page reached by client-side navigation from the home page.</p>
      <Link href="/">Back to the home page</Link>
    </main>
  );
}
