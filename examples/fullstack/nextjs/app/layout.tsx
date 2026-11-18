import type { ReactNode } from "react";

export const metadata = { title: "Next.js on a Lambda Web Function" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
