"use client";

import type {
  AdministrationProjectView,
  AdministrationSettingsView,
  AdministrationUserView,
  InvitationResult,
} from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

function apiMessage(body: unknown, fallback: string): string {
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

function UserRow({
  user,
  currentUserId,
  pending,
  save,
}: {
  user: AdministrationUserView;
  currentUserId: string;
  pending: boolean;
  save: (
    user: AdministrationUserView,
    state: AdministrationUserView["state"],
    role: AdministrationUserView["organizationRole"],
  ) => void;
}) {
  const [state, setState] = useState(user.state);
  const [role, setRole] = useState(user.organizationRole);
  return (
    <tr>
      <td>
        <strong>
          {user.displayName}
          {user.id === currentUserId ? " (you)" : ""}
        </strong>
        <small>{user.email}</small>
      </td>
      <td>
        <select
          aria-label={`Organization role for ${user.displayName}`}
          disabled={pending}
          onChange={(event) =>
            setRole(
              event.target.value as AdministrationUserView["organizationRole"],
            )
          }
          value={role}
        >
          <option value="ADMIN">Administrator</option>
          <option value="MEMBER">Member</option>
        </select>
      </td>
      <td>
        <select
          aria-label={`Account state for ${user.displayName}`}
          disabled={pending}
          onChange={(event) =>
            setState(event.target.value as AdministrationUserView["state"])
          }
          value={state}
        >
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option disabled value="INVITED">
            Invited
          </option>
        </select>
      </td>
      <td>{user.activeAssignments}</td>
      <td>
        <button
          className="secondary-button"
          disabled={
            pending ||
            user.state === "INVITED" ||
            (state === user.state && role === user.organizationRole)
          }
          onClick={() => save(user, state, role)}
          type="button"
        >
          Save user
        </button>
      </td>
    </tr>
  );
}

function ProjectRow({
  project,
  pending,
  save,
}: {
  project: AdministrationProjectView;
  pending: boolean;
  save: (
    project: AdministrationProjectView,
    draft: { name: string; boardName: string; archived: boolean },
  ) => void;
}) {
  const [name, setName] = useState(project.name);
  const [boardName, setBoardName] = useState(project.board.name);
  const [archived, setArchived] = useState(project.archived);
  const unchanged =
    name === project.name &&
    boardName === project.board.name &&
    archived === project.archived;
  return (
    <tr>
      <td>
        <strong>{project.key}</strong>
        <small>
          {project.issueCount} issues · {project.memberCount} members
        </small>
      </td>
      <td>
        <input
          aria-label={`Project name for ${project.key}`}
          disabled={pending}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </td>
      <td>
        <input
          aria-label={`Board name for ${project.key}`}
          disabled={pending}
          maxLength={100}
          onChange={(event) => setBoardName(event.target.value)}
          value={boardName}
        />
      </td>
      <td>
        <label className="inline-checkbox">
          <input
            checked={archived}
            disabled={pending}
            onChange={(event) => setArchived(event.target.checked)}
            type="checkbox"
          />
          Archived
        </label>
      </td>
      <td>
        <button
          className="secondary-button"
          disabled={pending || unchanged || !name.trim() || !boardName.trim()}
          onClick={() => save(project, { name, boardName, archived })}
          type="button"
        >
          Save project
        </button>
      </td>
    </tr>
  );
}

export function AdministrationSettings({
  displayName,
  currentUserId,
  initialView,
}: {
  displayName: string;
  currentUserId: string;
  initialView: AdministrationSettingsView;
}) {
  const [view, setView] = useState(initialView);
  const [organizationName, setOrganizationName] = useState(
    initialView.organization.name,
  );
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [activationUrl, setActivationUrl] = useState("");

  async function invite() {
    setPendingTarget("invitation");
    setError("");
    setNotice("");
    setActivationUrl("");
    try {
      const response = await fetch("/api/v1/administration/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          displayName: inviteName,
          organizationRole: inviteRole,
        }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          apiMessage(result, "The invitation could not be created."),
        );
      }
      const invitation = result as InvitationResult;
      setView(invitation.settings);
      setActivationUrl(invitation.activationUrl);
      setInviteEmail("");
      setInviteName("");
      setNotice(
        "Invitation created. Share the one-time activation link securely.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The invitation could not be created.",
      );
    } finally {
      setPendingTarget(null);
    }
  }

  async function update(
    url: string,
    body: Record<string, unknown>,
    target: string,
    success: string,
  ) {
    setPendingTarget(target);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(result, "Settings could not be updated."));
      }
      const updated = result as AdministrationSettingsView;
      setView(updated);
      setOrganizationName(updated.organization.name);
      setNotice(success);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Settings could not be updated.",
      );
    } finally {
      setPendingTarget(null);
    }
  }

  return (
    <main className="page-shell administration-settings-page">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <SearchLink />
          <NotificationLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="administration-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Organization settings</h1>
          <p className="muted">
            Manage organization identity, user access, and project lifecycle.
          </p>
        </div>
        <nav className="toolbar-actions" aria-label="Administration sections">
          <Link className="secondary-button" href="/administration/audit">
            Audit trail
          </Link>
          <Link className="secondary-button" href="/administration/outbox">
            Outbox
          </Link>
          <Link className="secondary-button" href="/administration/teams">
            Teams
          </Link>
        </nav>
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

      <section
        className="organization-name-settings"
        aria-labelledby="organization-title"
      >
        <div>
          <h2 id="organization-title">Organization</h2>
          <p className="muted">The display name shown to administrators.</p>
        </div>
        <label>
          Name
          <input
            disabled={pendingTarget !== null}
            maxLength={100}
            onChange={(event) => setOrganizationName(event.target.value)}
            value={organizationName}
          />
        </label>
        <button
          className="primary-button"
          disabled={
            pendingTarget !== null ||
            !organizationName.trim() ||
            organizationName === view.organization.name
          }
          onClick={() =>
            void update(
              "/api/v1/administration/settings",
              {
                name: organizationName,
                version: view.organization.version,
              },
              "organization",
              "Organization settings saved.",
            )
          }
          type="button"
        >
          Save organization
        </button>
      </section>

      <section aria-labelledby="organization-users-title">
        <h2 id="organization-users-title">Users</h2>
        <div className="invite-user-form">
          <label>
            Invitee name
            <input
              disabled={pendingTarget !== null}
              maxLength={100}
              onChange={(event) => setInviteName(event.target.value)}
              value={inviteName}
            />
          </label>
          <label>
            Invitee email
            <input
              disabled={pendingTarget !== null}
              maxLength={254}
              onChange={(event) => setInviteEmail(event.target.value)}
              type="email"
              value={inviteEmail}
            />
          </label>
          <label>
            Organization role
            <select
              disabled={pendingTarget !== null}
              onChange={(event) =>
                setInviteRole(event.target.value as "ADMIN" | "MEMBER")
              }
              value={inviteRole}
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </label>
          <button
            className="primary-button"
            disabled={
              pendingTarget !== null ||
              !inviteEmail.trim() ||
              !inviteName.trim()
            }
            onClick={() => void invite()}
            type="button"
          >
            Create invitation
          </button>
        </div>
        {activationUrl && (
          <label className="activation-link">
            One-time activation link (expires in 72 hours)
            <input readOnly value={activationUrl} />
          </label>
        )}
        <div className="issue-list-table-wrap">
          <table className="issue-list-table admin-settings-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">Assigned</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {view.users.map((user) => (
                <UserRow
                  currentUserId={currentUserId}
                  key={`${user.id}:${user.version}`}
                  pending={pendingTarget !== null}
                  save={(current, state, role) =>
                    void update(
                      `/api/v1/administration/users/${current.id}`,
                      {
                        state,
                        organizationRole: role,
                        version: current.version,
                      },
                      current.id,
                      `${current.displayName} updated.`,
                    )
                  }
                  user={user}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="organization-projects-title">
        <h2 id="organization-projects-title">Projects and boards</h2>
        <div className="issue-list-table-wrap">
          <table className="issue-list-table admin-settings-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Project name</th>
                <th scope="col">Board name</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {view.projects.map((project) => (
                <ProjectRow
                  key={`${project.id}:${project.version}:${project.board.version}`}
                  pending={pendingTarget !== null}
                  project={project}
                  save={(current, draft) =>
                    void update(
                      `/api/v1/administration/projects/${current.id}`,
                      {
                        ...draft,
                        version: current.version,
                        boardVersion: current.board.version,
                      },
                      current.id,
                      `${current.key} updated.`,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
