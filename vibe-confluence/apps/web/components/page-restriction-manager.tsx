"use client";

import type {
  PageRestrictionAdministration,
  SpaceMemberPage,
  SpaceMemberView,
} from "@knowledge/contracts";
import { useState, type FormEvent } from "react";

export function PageRestrictionManager({
  initialRestriction,
  initialMembers,
}: {
  initialRestriction: PageRestrictionAdministration;
  initialMembers: SpaceMemberPage;
}) {
  const [restriction, setRestriction] = useState(initialRestriction);
  const [restricted, setRestricted] = useState(initialRestriction.restricted);
  const [selected, setSelected] = useState(
    new Set(initialRestriction.memberIds),
  );
  const [members, setMembers] = useState(
    initialMembers.items as SpaceMemberView[],
  );
  const [nextCursor, setNextCursor] = useState(initialMembers.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function toggle(userId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/pages/${restriction.page.id}/restriction`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            restricted,
            memberIds: restricted ? Array.from(selected) : [],
            expectedVersion: restriction.version,
          }),
        },
      );
      const body = (await response.json()) as PageRestrictionAdministration & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Page access update failed");
      }
      setRestriction(body);
      setRestricted(body.restricted);
      setSelected(new Set(body.memberIds));
      setNotice(
        body.restricted
          ? `Restriction saved for ${body.memberIds.length} direct members.`
          : "Page restriction disabled.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Page access update failed",
      );
    } finally {
      setPending(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setPending(true);
    try {
      const search = new URLSearchParams({
        kind: "members",
        limit: "50",
        cursor: nextCursor,
      });
      const response = await fetch(
        `/api/v1/spaces/${restriction.space.key}/members?${search.toString()}`,
      );
      const body = (await response.json()) as SpaceMemberPage & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Members could not be loaded");
      }
      setMembers((current) => [
        ...current,
        ...(body.items as SpaceMemberView[]),
      ]);
      setNextCursor(body.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Members could not be loaded",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel access-policy-form" onSubmit={save}>
      <label className="checkbox-row">
        <input
          checked={restricted}
          onChange={(event) => setRestricted(event.target.checked)}
          type="checkbox"
        />
        Restrict this page and its descendants
      </label>
      <p className="muted">
        Allowed users must also satisfy every ancestor restriction. A child page
        cannot reopen access. Policy version {restriction.version}.
      </p>
      <fieldset disabled={!restricted || pending}>
        <legend>Direct members allowed by this restriction</legend>
        <ul className="checkbox-list">
          {members.map((member) => (
            <li key={member.userId}>
              <label>
                <input
                  checked={selected.has(member.userId)}
                  onChange={(event) =>
                    toggle(member.userId, event.target.checked)
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{member.displayName}</strong>
                  <small>
                    {member.email} · {member.role}
                  </small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {nextCursor ? (
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() => void loadMore()}
          type="button"
        >
          Load more members
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
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "Saving…" : "Save page access"}
      </button>
    </form>
  );
}
