import { createHash } from "node:crypto";

export const DEMO_USER = {
  email: "demo@example.com",
  password: "demo-password",
} as const;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Demo-only comparison mirroring the upstream starter; never use for real credentials. */
export function demoCredentialsMatch(email: string, password: string): boolean {
  return email === DEMO_USER.email && digest(password) === digest(DEMO_USER.password);
}
