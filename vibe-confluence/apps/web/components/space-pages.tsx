"use client";

import type { PageSummary } from "@knowledge/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";

export function SpacePages({
  canAdminister,
  spaceKey,
  initialPages,
}: {
  canAdminister: boolean;
  spaceKey: string;
  initialPages: PageSummary[];
}) {
  const [pages, setPages] = useState(initialPages);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const parentValue = data.get("parentId");
    const response = await fetch(`/api/v1/spaces/${spaceKey}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: data.get("title"),
        parentId: parentValue || null,
      }),
    });
    const body = (await response.json()) as {
      page?: PageSummary;
      error?: { message?: string };
    };
    if (!response.ok || !body.page) {
      setError(body.error?.message ?? "Page creation failed");
    } else {
      setPages((current) => [...current, body.page!]);
      form.reset();
    }
    setPending(false);
  }

  return (
    <div className="split-grid">
      <section className="panel">
        <h2>Page tree</h2>
        {pages.length ? (
          <ul className="page-tree">
            {pages.map((page) => (
              <li className={page.parentId ? "child-page" : ""} key={page.id}>
                <Link href={`/pages/${page.id}`}>
                  <span aria-hidden="true">▤</span>
                  {page.title}
                </Link>
                {page.currentRevisionId ? (
                  <span className="published-badge">Published</span>
                ) : (
                  <span className="draft-badge">Draft</span>
                )}
                {canAdminister ? (
                  <Link
                    className="inline-action"
                    href={`/pages/${page.id}/access`}
                  >
                    Access
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">This space has no pages yet.</p>
        )}
      </section>
      <section className="panel compact-panel">
        <h2>Create a page</h2>
        <form className="stack-form" onSubmit={create}>
          <label>
            Title
            <input name="title" maxLength={200} required />
          </label>
          <label>
            Parent page
            <select name="parentId" defaultValue="">
              <option value="">No parent</option>
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Creating…" : "Create page"}
          </button>
        </form>
      </section>
    </div>
  );
}
