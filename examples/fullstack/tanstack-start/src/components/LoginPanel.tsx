import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { DEMO_USER } from "../utils/demo-user";

const panelCss = `
.login-panel { max-width: 22rem; display: grid; gap: 0.75rem; }
.login-panel form { display: grid; gap: 0.5rem; }
.login-panel label { display: grid; gap: 0.25rem; }
.login-panel input { padding: 0.375rem 0.5rem; }
.login-hint { color: #555; }
.login-error { color: #b00020; }
`;

export function LoginPanel() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>(DEMO_USER.email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(payload?.message ?? "Sign in failed");
      return;
    }
    await navigate({ to: "/profile" });
  }

  return (
    <section className="login-panel">
      <style>{panelCss}</style>
      <form onSubmit={submit}>
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">Sign in</button>
      </form>
      <p className="login-hint">
        Demo credentials: {DEMO_USER.email} / {DEMO_USER.password}
      </p>
      {error ? <p className="login-error" id="login-error">{error}</p> : null}
    </section>
  );
}
