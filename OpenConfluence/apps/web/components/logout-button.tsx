"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <button className="nav-button" onClick={logout} type="button">
      Sign out
    </button>
  );
}
