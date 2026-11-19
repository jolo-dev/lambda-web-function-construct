import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/profile")({
  component: Profile,
});

function Profile() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();

  async function logout(event: React.FormEvent) {
    event.preventDefault();
    await fetch("/api/logout", { method: "POST" });
    await navigate({ to: "/" });
  }

  return (
    <main className="aurora-shell">
      <section aria-label="ACCOUNT" className="aurora-card mx-auto w-full max-w-md">
        <p className="aurora-label">ACCOUNT</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">Protected profile</h1>
        <p id="profile-email" className="mt-4 text-lg font-semibold text-indigo-50">{user?.email}</p>
        <p className="mt-1 text-sm text-indigo-200/70">
          Signed in through the stateless app-session cookie on the Web Function.
        </p>
        <p className="aurora-warn mt-4 text-sm">
          iron-session is stateless: logging out clears this browser's cookie but cannot revoke
          previously issued copies.
        </p>
        <form method="post" action="/api/logout" className="mt-6" onSubmit={logout}>
          <button type="submit" className="aurora-button w-full">Log out</button>
        </form>
      </section>
    </main>
  );
}
