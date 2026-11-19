import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAppSession } from "../utils/session";

const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await getAppSession();
  await session.destroy();
  throw redirect({ href: "/" });
});

export const Route = createFileRoute("/logout")({
  preload: false,
  loader: () => logoutFn(),
});
