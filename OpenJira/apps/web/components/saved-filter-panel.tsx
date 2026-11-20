"use client";

import type {
  IssueSearchQuery,
  ProjectSummary,
  SavedFilterView,
  SavedFilterVisibility,
} from "@vibe/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

export function SavedFilterPanel({
  currentQuery,
  initialFilters,
  projects,
}: {
  currentQuery: IssueSearchQuery;
  initialFilters: SavedFilterView[];
  projects: ProjectSummary[];
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [visibility, setVisibility] =
    useState<SavedFilterVisibility>("PRIVATE");
  const [projectKey, setProjectKey] = useState("");
  const [isQuick, setIsQuick] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get("name") ?? "");
    try {
      const response = await fetch("/api/v1/filters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          visibility,
          projectKey: projectKey || null,
          query: currentQuery,
          isQuick,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(errorMessage(body, "Could not save this filter"));
      }
      const saved = body as SavedFilterView;
      setFilters((current) => [saved, ...current]);
      form.reset();
      setVisibility("PRIVATE");
      setProjectKey("");
      setIsQuick(false);
      setNotice(`${saved.name} saved.`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save this filter",
      );
    } finally {
      setPending(false);
    }
  }

  async function rename(filter: SavedFilterView) {
    const name = window.prompt("Saved filter name", filter.name)?.trim();
    if (!name || name === filter.name) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/filters/${filter.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          visibility: filter.visibility,
          projectKey: filter.project?.key ?? null,
          query: filter.query,
          isQuick: filter.isQuick,
          version: filter.version,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(errorMessage(body, "Could not rename this filter"));
      }
      const updated = body as SavedFilterView;
      setFilters((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice(`${updated.name} updated.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not rename this filter",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(filter: SavedFilterView) {
    if (!window.confirm(`Delete ${filter.name}?`)) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/filters/${filter.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: filter.version }),
      });
      if (!response.ok) {
        const body: unknown = await response.json();
        throw new Error(errorMessage(body, "Could not delete this filter"));
      }
      setFilters((current) => current.filter((item) => item.id !== filter.id));
      setNotice(`${filter.name} deleted.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not delete this filter",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="saved-filter-panel" aria-labelledby="saved-filters-title">
      <h2 id="saved-filters-title">Saved filters</h2>
      <p className="muted">Reuse this search or share it with a team.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-banner" aria-live="polite">
          {notice}
        </p>
      )}
      <form className="saved-filter-form" onSubmit={save}>
        <label>
          Name
          <input maxLength={100} name="name" required />
        </label>
        <label>
          Visibility
          <select
            value={visibility}
            onChange={(event) => {
              const next = event.target.value as SavedFilterVisibility;
              setVisibility(next);
              if (next !== "PROJECT") setIsQuick(false);
            }}
          >
            <option value="PRIVATE">Private</option>
            <option value="PROJECT">Project</option>
            <option value="ORGANIZATION">Organization</option>
          </select>
        </label>
        <label>
          Project
          <select
            disabled={visibility === "ORGANIZATION"}
            required={visibility === "PROJECT"}
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.key}>
                {project.key} · {project.name}
              </option>
            ))}
          </select>
        </label>
        {visibility === "PROJECT" && (
          <label className="checkbox-row">
            <input
              checked={isQuick}
              onChange={(event) => setIsQuick(event.target.checked)}
              type="checkbox"
            />
            Show as a board quick filter
          </label>
        )}
        <button className="primary-button" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save current search"}
        </button>
      </form>

      <div className="saved-filter-list">
        {filters.length === 0 && (
          <p className="empty-state">No saved filters are visible to you.</p>
        )}
        {filters.map((filter) => (
          <article key={filter.id}>
            <div>
              <Link href={`/filters/${filter.id}`}>
                <strong>{filter.name}</strong>
              </Link>
              <small>
                {filter.visibility.toLocaleLowerCase()}
                {filter.project ? ` · ${filter.project.key}` : ""}
                {filter.isQuick ? " · quick filter" : ""}
              </small>
            </div>
            {filter.canEdit && (
              <div className="saved-filter-actions">
                <button
                  className="text-button"
                  disabled={pending}
                  onClick={() => void rename(filter)}
                  type="button"
                >
                  Rename
                </button>
                <button
                  className="danger-button"
                  disabled={pending}
                  onClick={() => void remove(filter)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </aside>
  );
}
