import { createFileRoute } from "@tanstack/react-router";
import { LoginPanel } from "../components/LoginPanel";

export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  return (
    <main>
      <h1>Sign in</h1>
      <LoginPanel />
    </main>
  );
}
