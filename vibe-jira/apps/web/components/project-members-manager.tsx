"use client";

import type {
  ProjectMembersView,
  ProjectMemberView,
  ProjectRole,
} from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

const roleLabels: Record<ProjectRole, string> = {
  ADMIN: "Project admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

function apiMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

export function ProjectMembersManager({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: ProjectMembersView;
}) {
  const [members, setMembers] = useState(initialView.members);
  const [draftRoles, setDraftRoles] = useState<Record<string, ProjectRole>>(
    Object.fromEntries(
      initialView.members.map((member) => [
        member.id,
        member.projectRole ?? "MEMBER",
      ]),
    ),
  );
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function replaceMember(updated: ProjectMemberView) {
    setMembers((current) =>
      current.map((member) => (member.id === updated.id ? updated : member)),
    );
    if (updated.projectRole) {
      setDraftRoles((current) => ({
        ...current,
        [updated.id]: updated.projectRole!,
      }));
    }
  }

  async function saveMember(member: ProjectMemberView) {
    const role = draftRoles[member.id] ?? "MEMBER";
    setPendingUserId(member.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/projects/${initialView.project.key}/members/${member.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(body, `Could not update ${member.displayName}.`));
        return;
      }
      replaceMember(body as ProjectMemberView);
      setNotice(
        `${member.displayName} ${member.projectRole ? "updated" : "added"} as ${roleLabels[role]}.`,
      );
    } catch {
      setError(`Could not update ${member.displayName}. Try again.`);
    } finally {
      setPendingUserId(null);
    }
  }

  async function removeMember(member: ProjectMemberView) {
    if (!window.confirm(`Remove ${member.displayName} from this project?`)) {
      return;
    }
    setPendingUserId(member.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/projects/${initialView.project.key}/members/${member.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body: unknown = await response.json();
        setError(apiMessage(body, `Could not remove ${member.displayName}.`));
        return;
      }
      replaceMember({ ...member, projectRole: null });
      setNotice(`${member.displayName} removed from the project.`);
    } catch {
      setError(`Could not remove ${member.displayName}. Try again.`);
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="board-breadcrumbs">
          <Link className="brand" href="/projects">
            <span>V</span> Vibe JIRA
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href={`/projects/${initialView.project.key}/boards/${initialView.project.boardId}`}
          >
            {initialView.project.name}
          </Link>
        </div>
        <div className="user-actions">
          <SearchLink />
          <NotificationLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="settings-shell" aria-labelledby="members-title">
        <div className="settings-heading">
          <div>
            <p className="eyebrow">Project settings</p>
            <h1 id="members-title">Members and roles</h1>
            <p className="muted">
              Give existing organization users access to{" "}
              {initialView.project.name}.
            </p>
          </div>
          <Link
            className="secondary-button"
            href={`/projects/${initialView.project.key}/boards/${initialView.project.boardId}`}
          >
            Back to board
          </Link>
        </div>

        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
        {notice && (
          <div className="notice settings-notice" role="status">
            {notice}
          </div>
        )}
        {error && (
          <p className="form-error settings-error" role="alert">
            {error}
          </p>
        )}

        <div className="member-table-wrap">
          <table className="member-table">
            <caption className="sr-only">
              Organization users and their roles in {initialView.project.name}
            </caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Organization</th>
                <th scope="col">Project role</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const draftRole = draftRoles[member.id] ?? "MEMBER";
                const pending = pendingUserId === member.id;
                const inactive = member.state !== "ACTIVE";
                return (
                  <tr key={member.id}>
                    <td>
                      <strong>{member.displayName}</strong>
                      <small>{member.email}</small>
                    </td>
                    <td>
                      {member.organizationRole === "ADMIN"
                        ? "Organization admin"
                        : "Organization member"}
                      {inactive && <small>Inactive</small>}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`role-${member.id}`}>
                        Project role for {member.displayName}
                      </label>
                      <select
                        id={`role-${member.id}`}
                        value={draftRole}
                        disabled={pending || inactive}
                        onChange={(event) =>
                          setDraftRoles((current) => ({
                            ...current,
                            [member.id]: event.target.value as ProjectRole,
                          }))
                        }
                      >
                        {Object.entries(roleLabels).map(([role, label]) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <small>
                        Current:{" "}
                        {member.projectRole
                          ? roleLabels[member.projectRole]
                          : "No access"}
                      </small>
                    </td>
                    <td>
                      <div className="member-actions">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={
                            pending ||
                            inactive ||
                            member.projectRole === draftRole
                          }
                          onClick={() => void saveMember(member)}
                        >
                          {pending
                            ? "Saving…"
                            : member.projectRole
                              ? "Save role"
                              : "Add to project"}
                        </button>
                        {member.projectRole && (
                          <button
                            className="danger-button"
                            type="button"
                            disabled={pending}
                            onClick={() => void removeMember(member)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
