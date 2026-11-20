"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function InvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (password !== confirmation) {
      setError("Passwords do not match.");
      setPending(false);
      return;
    }
    const response = await fetch("/api/v1/auth/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const result = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) {
      setError(
        result.error?.message ?? "The invitation could not be accepted.",
      );
      setPending(false);
      return;
    }
    router.push("/projects");
    router.refresh();
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <label>
        Password
        <input
          autoComplete="new-password"
          minLength={12}
          name="password"
          required
          type="password"
        />
      </label>
      <label>
        Confirm password
        <input
          autoComplete="new-password"
          minLength={12}
          name="confirmation"
          required
          type="password"
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "Activating…" : "Activate account"}
      </button>
    </form>
  );
}
