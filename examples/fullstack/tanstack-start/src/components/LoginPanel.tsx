import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { DEMO_USER } from "../utils/demo-user";

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
    <section aria-label="DEMO SESSION" className="aurora-card mx-auto w-full max-w-md">
      <p className="aurora-label">DEMO SESSION</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">Welcome back</h1>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-email" className="text-sm text-indigo-200/80">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            className="aurora-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-password" className="text-sm text-indigo-200/80">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="aurora-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>
        <button type="submit" className="aurora-button w-full">Sign in</button>
      </form>
      <p className="mt-4 text-sm text-indigo-200/70">
        Demo credentials: {DEMO_USER.email} / {DEMO_USER.password}
      </p>
      {error ? <p className="aurora-warn mt-3 text-sm font-semibold" id="login-error" role="alert">{error}</p> : null}
    </section>
  );
}
