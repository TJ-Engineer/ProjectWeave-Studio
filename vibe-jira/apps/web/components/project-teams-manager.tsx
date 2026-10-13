"use client";

import type { ProjectRole, ProjectTeamsView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";

export function ProjectTeamsManager({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: ProjectTeamsView;
}) {
  const [view, setView] = useState(initialView);
  const [drafts, setDrafts] = useState<Record<string, ProjectRole | "">>(() =>
    Object.fromEntries(
      initialView.teams.map((team) => [team.id, team.projectRole ?? ""]),
    ),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save(teamId: string) {
    const role = drafts[teamId] ?? "";
    setPending(teamId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/teams/${teamId}`,
        {
          method: role ? "PUT" : "DELETE",
          headers: { "content-type": "application/json" },
          ...(role ? { body: JSON.stringify({ role }) } : {}),
        },
      );
      const result = (await response.json()) as ProjectTeamsView & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(
          result.error?.message ?? "Team access could not be updated.",
        );
      setView(result);
      setNotice("Project team access updated.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Team access could not be updated.",
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="page-shell project-teams-page">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="settings-heading">
        <div>
          <p className="eyebrow">{view.project.key} · project settings</p>
          <h1>Team access</h1>
          <p className="muted">
            The strongest direct or team role becomes each user's effective
            role.
          </p>
        </div>
        <Link
          className="secondary-button"
          href={`/projects/${view.project.key}/boards/${view.project.boardId}`}
        >
          Back to board
        </Link>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-banner" aria-live="polite">
          {notice}
        </p>
      )}
      <div className="issue-list-table-wrap">
        <table className="issue-list-table">
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Members</th>
              <th scope="col">Project role</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.teams.map((team) => (
              <tr key={team.id}>
                <td>{team.name}</td>
                <td>{team.memberCount}</td>
                <td>
                  <select
                    aria-label={`Project role for team ${team.name}`}
                    disabled={pending !== null}
                    value={drafts[team.id] ?? ""}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [team.id]: event.target.value as ProjectRole | "",
                      }))
                    }
                  >
                    <option value="">No access</option>
                    <option value="ADMIN">Administrator</option>
                    <option value="MEMBER">Member</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                </td>
                <td>
                  <button
                    className="secondary-button"
                    disabled={
                      pending !== null ||
                      (drafts[team.id] ?? "") === (team.projectRole ?? "")
                    }
                    onClick={() => void save(team.id)}
                    type="button"
                  >
                    Save team access
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
