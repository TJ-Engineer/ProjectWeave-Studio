"use client";

import type { Page, ProjectSummary } from "@vibe/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { LogoutButton } from "./logout-button";

export function ProjectHub({
  displayName,
  initialProjects,
  initialNextCursor,
}: {
  displayName: string;
  initialProjects: ProjectSummary[];
  initialNextCursor: string | null;
}) {
  const router = useRouter();
  const createIdempotencyKey = useRef<string | null>(null);
  const [projects, setProjects] = useState(initialProjects);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    createIdempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": createIdempotencyKey.current,
        },
        body: JSON.stringify({ name: form.get("name"), key: form.get("key") }),
      });
      const body = (await response.json()) as ProjectSummary & {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(body.error?.message ?? "Could not create project");
        return;
      }
      router.push(`/projects/${body.key}/boards/${body.boardId}`);
    } catch {
      setError("The project request could not be completed. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/projects?limit=25&cursor=${encodeURIComponent(nextCursor)}`,
      );
      const body = (await response.json()) as Page<ProjectSummary> & {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(body.error?.message ?? "Could not load more projects");
        return;
      }
      setProjects((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
    } catch {
      setError("More projects could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="content-grid">
        <section>
          <p className="eyebrow">Workspace</p>
          <h1>Projects</h1>
          <p className="muted">Choose a board or start a focused workspace.</p>
          <div className="project-list">
            {projects.map((project) => (
              <Link
                className="project-card"
                href={`/projects/${project.key}/boards/${project.boardId}`}
                key={project.id}
              >
                <span className="project-avatar">
                  {project.key.slice(0, 2)}
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.key} · Kanban board</small>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
          {nextCursor && (
            <button
              className="secondary-button"
              disabled={loadingMore}
              type="button"
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more projects"}
            </button>
          )}
        </section>
        <aside className="create-panel">
          <h2>Create a project</h2>
          <p className="muted">
            A five-status workflow and three-column board are created
            automatically.
          </p>
          <form className="stack-form" onSubmit={create}>
            <label>
              Project name
              <input name="name" maxLength={100} required />
            </label>
            <label>
              Project key
              <input
                name="key"
                pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                placeholder="ENG"
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? "Creating…" : "Create project"}
            </button>
          </form>
        </aside>
      </div>
    </main>
  );
}
