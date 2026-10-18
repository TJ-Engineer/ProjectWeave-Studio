import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import "./styles.css";

export const metadata: Metadata = {
  title: "Vibe Knowledge",
  description: "A safe, self-hostable team knowledge workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link aria-label="Vibe Knowledge" className="brand" href="/spaces">
            <span className="brand-mark" aria-hidden="true">
              V
            </span>
            <span>Vibe Knowledge</span>
          </Link>
          <nav aria-label="Global navigation">
            <Link href="/spaces">Spaces</Link>
            <LogoutButton />
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
