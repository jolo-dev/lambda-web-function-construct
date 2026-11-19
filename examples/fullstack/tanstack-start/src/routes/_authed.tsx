import { createFileRoute, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { LoginPanel } from "../components/LoginPanel";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw new Error("Not authenticated");
    }
  },
  errorComponent: AuthError,
  component: () => <Outlet />,
});

function AuthError({ error }: ErrorComponentProps) {
  if (!(error instanceof Error) || error.message !== "Not authenticated") throw error;
  return (
    <main className="aurora-shell">
      <LoginPanel />
    </main>
  );
}
