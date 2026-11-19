"use client";

import type { AdministrationTeamsView, TeamView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";

function message(body: unknown): string {
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
  return "Teams could not be updated.";
}

function TeamEditor({
  team,
  view,
  pending,
  save,
}: {
  team: TeamView;
  view: AdministrationTeamsView;
  pending: boolean;
  save: (team: TeamView, name: string, memberIds: string[]) => void;
}) {
  const [name, setName] = useState(team.name);
  const [memberIds, setMemberIds] = useState(
    () => new Set(team.members.map((member) => member.id)),
  );
  return (
    <article className="team-card">
      <label>
        Team name
        <input
          aria-label={`Team name for ${team.name}`}
          disabled={pending}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <fieldset>
        <legend>Members</legend>
        <div className="team-member-options">
          {view.users.map((user) => (
            <label className="inline-checkbox" key={user.id}>
              <input
                checked={memberIds.has(user.id)}
                disabled={pending}
                onChange={(event) => {
                  setMemberIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(user.id);
                    else next.delete(user.id);
                    return next;
                  });
                }}
                type="checkbox"
              />
              {user.displayName} <small>{user.email}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        className="primary-button"
        disabled={pending || !name.trim()}
        onClick={() => save(team, name, [...memberIds])}
        type="button"
      >
        Save team
      </button>
    </article>
  );
}

export function TeamsAdministration({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: AdministrationTeamsView;
}) {
  const [view, setView] = useState(initialView);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function mutate(url: string, method: "POST" | "PUT", body: object) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(message(result));
      setView(result as AdministrationTeamsView);
      setNotice("Teams updated.");
      if (method === "POST") setNewName("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Teams could not be updated.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="page-shell teams-page">
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
          <p className="eyebrow">Administration</p>
          <h1>Teams</h1>
          <p className="muted">
            Group active users, then grant the team a project role.
          </p>
        </div>
        <Link className="secondary-button" href="/administration/settings">
          Organization settings
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
      <section className="create-team" aria-labelledby="create-team-title">
        <h2 id="create-team-title">Create team</h2>
        <label>
          Name
          <input
            disabled={pending}
            maxLength={100}
            onChange={(event) => setNewName(event.target.value)}
            value={newName}
          />
        </label>
        <button
          className="primary-button"
          disabled={pending || !newName.trim()}
          onClick={() =>
            void mutate("/api/v1/administration/teams", "POST", {
              name: newName,
            })
          }
          type="button"
        >
          Create team
        </button>
      </section>
      <section className="team-grid" aria-label="Organization teams">
        {view.teams.length === 0 ? (
          <p className="empty-state">No teams yet.</p>
        ) : (
          view.teams.map((team) => (
            <TeamEditor
              key={`${team.id}:${team.version}`}
              pending={pending}
              team={team}
              view={view}
              save={(current, name, memberIds) =>
                void mutate(
                  `/api/v1/administration/teams/${current.id}`,
                  "PUT",
                  { name, memberIds, version: current.version },
                )
              }
            />
          ))
        )}
      </section>
    </main>
  );
}
