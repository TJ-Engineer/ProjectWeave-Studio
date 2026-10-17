"use client";

import type { SpaceSummary } from "@knowledge/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";

export function SpacesManager({
  initialSpaces,
}: {
  initialSpaces: SpaceSummary[];
}) {
  const [spaces, setSpaces] = useState(initialSpaces);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/v1/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: data.get("key"),
        name: data.get("name"),
        description: data.get("description"),
      }),
    });
    const body = (await response.json()) as {
      space?: SpaceSummary;
      error?: { message?: string };
    };
    if (!response.ok || !body.space) {
      setError(body.error?.message ?? "Space creation failed");
    } else {
      setSpaces((current) => [...current, body.space!]);
      form.reset();
    }
    setPending(false);
  }

  return (
    <div className="split-grid">
      <section className="panel" aria-labelledby="space-list-heading">
        <h2 id="space-list-heading">Your spaces</h2>
        {spaces.length ? (
          <ul className="card-list">
            {spaces.map((space) => (
              <li key={space.id}>
                <Link className="space-card" href={`/spaces/${space.key}`}>
                  <span className="space-key">{space.key}</span>
                  <strong>{space.name}</strong>
                  <span>{space.description || "Open this space"}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            Create the first space to begin writing.
          </p>
        )}
      </section>
      <section
        className="panel compact-panel"
        aria-labelledby="create-space-heading"
      >
        <h2 id="create-space-heading">Create a space</h2>
        <form className="stack-form" onSubmit={create}>
          <label>
            Name
            <input name="name" maxLength={100} required />
          </label>
          <label>
            Key
            <input
              name="key"
              maxLength={10}
              pattern="[A-Za-z][A-Za-z0-9]{1,9}"
              required
            />
          </label>
          <label>
            Description
            <textarea name="description" maxLength={2000} rows={3} />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Creating…" : "Create space"}
          </button>
        </form>
      </section>
    </div>
  );
}
