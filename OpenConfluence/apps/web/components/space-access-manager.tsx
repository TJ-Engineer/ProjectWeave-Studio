"use client";

import type {
  OrganizationMemberCandidate,
  SpaceMemberPage,
  SpaceMemberView,
  SpaceRole,
} from "@knowledge/contracts";
import { useState, type FormEvent } from "react";

interface ApiFailure {
  error?: { message?: string };
}

function memberItems(page: SpaceMemberPage): SpaceMemberView[] {
  return page.items as SpaceMemberView[];
}

function candidateItems(page: SpaceMemberPage): OrganizationMemberCandidate[] {
  return page.items as OrganizationMemberCandidate[];
}

export function SpaceAccessManager({
  currentUserId,
  initialMembers,
  initialCandidates,
}: {
  currentUserId: string;
  initialMembers: SpaceMemberPage;
  initialCandidates: SpaceMemberPage;
}) {
  const [members, setMembers] = useState(memberItems(initialMembers));
  const [membershipVersion, setMembershipVersion] = useState(
    initialMembers.membershipVersion,
  );
  const [nextMemberCursor, setNextMemberCursor] = useState(
    initialMembers.nextCursor,
  );
  const [candidates, setCandidates] = useState(
    candidateItems(initialCandidates),
  );
  const [nextCandidateCursor, setNextCandidateCursor] = useState(
    initialCandidates.nextCursor,
  );
  const [candidateQuery, setCandidateQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const spaceKey = initialMembers.space.key;

  async function readPage(
    kind: "members" | "candidates",
    options: { cursor?: string | null; query?: string } = {},
  ): Promise<SpaceMemberPage> {
    const search = new URLSearchParams({ kind, limit: "50" });
    if (options.cursor) search.set("cursor", options.cursor);
    if (options.query) search.set("query", options.query);
    const response = await fetch(
      `/api/v1/spaces/${spaceKey}/members?${search.toString()}`,
    );
    const body = (await response.json()) as SpaceMemberPage & ApiFailure;
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Access data could not be loaded");
    }
    return body;
  }

  async function refresh() {
    const [memberPage, candidatePage] = await Promise.all([
      readPage("members"),
      readPage("candidates", { query: candidateQuery }),
    ]);
    setMembers(memberItems(memberPage));
    setMembershipVersion(memberPage.membershipVersion);
    setNextMemberCursor(memberPage.nextCursor);
    setCandidates(candidateItems(candidatePage));
    setNextCandidateCursor(candidatePage.nextCursor);
  }

  async function mutate(
    userId: string,
    method: "PUT" | "DELETE",
    body: Record<string, unknown>,
  ): Promise<{ affectedPageGrantCount?: number } | null> {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/spaces/${spaceKey}/members/${userId}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = (await response.json()) as {
        affectedPageGrantCount?: number;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(result.error?.message ?? "Membership update failed");
      }
      if (userId === currentUserId) {
        window.location.assign(`/spaces/${spaceKey}`);
        return result;
      }
      await refresh();
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Membership update failed",
      );
      return null;
    } finally {
      setPending(false);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const userId = String(data.get("userId") ?? "");
    const role = String(data.get("role") ?? "VIEWER") as SpaceRole;
    if (!userId) return;
    const result = await mutate(userId, "PUT", {
      role,
      expectedMembershipVersion: membershipVersion,
    });
    if (result) setNotice("Member added.");
  }

  async function changeRole(
    event: FormEvent<HTMLFormElement>,
    member: SpaceMemberView,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const role = String(data.get("role") ?? member.role) as SpaceRole;
    const result = await mutate(member.userId, "PUT", {
      role,
      expectedMembershipVersion: membershipVersion,
    });
    if (result) setNotice(`${member.displayName}'s role is now ${role}.`);
  }

  async function remove(member: SpaceMemberView) {
    if (
      !window.confirm(
        `Remove ${member.displayName}? ${member.pageGrantCount} page allowlist entr${member.pageGrantCount === 1 ? "y" : "ies"} will be pruned.`,
      )
    ) {
      return;
    }
    const result = await mutate(member.userId, "DELETE", {
      expectedMembershipVersion: membershipVersion,
    });
    if (result) {
      setNotice(
        `Member removed. ${result.affectedPageGrantCount ?? 0} page allowlist entries were pruned.`,
      );
    }
  }

  async function searchCandidates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const page = await readPage("candidates", { query: candidateQuery });
      setCandidates(candidateItems(page));
      setNextCandidateCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed");
    } finally {
      setPending(false);
    }
  }

  async function loadMoreMembers() {
    if (!nextMemberCursor) return;
    setPending(true);
    try {
      const page = await readPage("members", { cursor: nextMemberCursor });
      setMembers((current) => [...current, ...memberItems(page)]);
      setNextMemberCursor(page.nextCursor);
      setMembershipVersion(page.membershipVersion);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Members could not be loaded",
      );
    } finally {
      setPending(false);
    }
  }

  async function loadMoreCandidates() {
    if (!nextCandidateCursor) return;
    setPending(true);
    try {
      const page = await readPage("candidates", {
        cursor: nextCandidateCursor,
        query: candidateQuery,
      });
      setCandidates((current) => [...current, ...candidateItems(page)]);
      setNextCandidateCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Candidates could not be loaded",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="access-grid">
      <section className="panel" aria-labelledby="space-members-heading">
        <h2 id="space-members-heading">Space members</h2>
        <p className="muted">
          Counts identify affected private work and allowlist entries without
          revealing page titles. Membership policy version {membershipVersion}.
        </p>
        <ul className="access-list">
          {members.map((member) => (
            <li key={member.userId}>
              <div>
                <strong>{member.displayName}</strong>
                <span>{member.email}</span>
                <span>
                  {member.unpublishedPageCount} unpublished ·{" "}
                  {member.pageGrantCount} page grants
                </span>
              </div>
              <form onSubmit={(event) => void changeRole(event, member)}>
                <label>
                  <span className="visually-hidden">
                    Role for {member.displayName}
                  </span>
                  <select name="role" defaultValue={member.role}>
                    <option value="ADMIN">Admin</option>
                    <option value="EDITOR">Editor</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                </label>
                <button disabled={pending} type="submit">
                  Update role
                </button>
                <button
                  className="danger-button"
                  disabled={pending}
                  onClick={() => void remove(member)}
                  type="button"
                >
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
        {nextMemberCursor ? (
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() => void loadMoreMembers()}
            type="button"
          >
            Load more members
          </button>
        ) : null}
      </section>

      <section
        className="panel compact-panel"
        aria-labelledby="add-member-heading"
      >
        <h2 id="add-member-heading">Add a member</h2>
        <form className="stack-form" onSubmit={searchCandidates}>
          <label>
            Search active organization members
            <input
              maxLength={100}
              onChange={(event) => setCandidateQuery(event.target.value)}
              type="search"
              value={candidateQuery}
            />
          </label>
          <button className="secondary-button" disabled={pending} type="submit">
            Search
          </button>
        </form>
        <form className="stack-form add-member-form" onSubmit={addMember}>
          <label>
            Member
            <select name="userId" required>
              <option value="">Select a member</option>
              {candidates.map((candidate) => (
                <option key={candidate.userId} value={candidate.userId}>
                  {candidate.displayName} — {candidate.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select name="role" defaultValue="VIEWER">
              <option value="ADMIN">Admin</option>
              <option value="EDITOR">Editor</option>
              <option value="VIEWER">Viewer</option>
            </select>
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            Add member
          </button>
        </form>
        {nextCandidateCursor ? (
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() => void loadMoreCandidates()}
            type="button"
          >
            Load more candidates
          </button>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="form-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
    </div>
  );
}
