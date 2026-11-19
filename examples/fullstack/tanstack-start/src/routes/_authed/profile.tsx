import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/profile")({
  component: Profile,
});

function Profile() {
  const { user } = Route.useRouteContext();
  return (
    <main>
      <h1>Protected profile</h1>
      <p id="profile-email">{user?.email}</p>
    </main>
  );
}
