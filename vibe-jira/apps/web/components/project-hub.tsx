"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LogoutButton } from "./logout-button";

interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  boardId: string;
}

export function ProjectHub({
  displayName,
  initialProjects,
}: {
  displayName: string;
  initialProjects: ProjectSummary[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), key: form.get("key") }),
    });
    const body = (await response.json()) as ProjectSummary & {
      error?: { message?: string };
    };
    if (!response.ok) {
      setError(body.error?.message ?? "Could not create project");
      setPending(false);
      return;
    }
    router.push(`/projects/${body.key}/boards/${body.boardId}`);
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
            {initialProjects.map((project) => (
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
