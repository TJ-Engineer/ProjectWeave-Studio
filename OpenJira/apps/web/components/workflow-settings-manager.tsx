"use client";

import type {
  StatusCategory,
  WorkflowSettingsView,
  WorkflowStatusView,
} from "@vibe/contracts";
import { useState } from "react";

interface TransitionDraft {
  id: string;
  fromStatusId: string;
  toStatusId: string;
}

interface RemovedStatus {
  status: WorkflowStatusView;
  targetId: string;
}

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

export function WorkflowSettingsManager({
  initialView,
  onColumnsChanged,
}: {
  initialView: WorkflowSettingsView;
  onColumnsChanged: (columns: WorkflowSettingsView["columns"]) => void;
}) {
  const [persistedStatusIds, setPersistedStatusIds] = useState(
    () => new Set(initialView.statuses.map((status) => status.id)),
  );
  const [view, setView] = useState(initialView);
  const [statuses, setStatuses] = useState(initialView.statuses);
  const [transitions, setTransitions] = useState<TransitionDraft[]>(
    initialView.transitions.map((transition) => ({ ...transition })),
  );
  const [removed, setRemoved] = useState<RemovedStatus[]>([]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function updateStatus(statusId: string, change: Partial<WorkflowStatusView>) {
    setStatuses((current) =>
      current.map((status) =>
        status.id === statusId ? { ...status, ...change } : status,
      ),
    );
  }

  function moveStatus(statusId: string, offset: -1 | 1) {
    setStatuses((current) => {
      const index = current.findIndex((status) => status.id === statusId);
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= current.length)
        return current;
      const next = [...current];
      const [status] = next.splice(index, 1);
      next.splice(destination, 0, status!);
      return next;
    });
  }

  function addStatus() {
    const column = view.columns[0];
    if (!column) return;
    setStatuses((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: "New status",
        category: "TODO",
        color: "#64748b",
        position: current.length,
        columnId: column.id,
        issueCount: 0,
      },
    ]);
  }

  function removeStatus(status: WorkflowStatusView) {
    setStatuses((current) => current.filter((item) => item.id !== status.id));
    setTransitions((current) =>
      current.filter(
        (transition) =>
          transition.fromStatusId !== status.id &&
          transition.toStatusId !== status.id,
      ),
    );
    if (persistedStatusIds.has(status.id)) {
      setRemoved((current) => [...current, { status, targetId: "" }]);
    }
  }

  function addTransition() {
    if (statuses.length < 2) return;
    setTransitions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        fromStatusId: statuses[0]!.id,
        toStatusId: statuses[1]!.id,
      },
    ]);
  }

  async function save() {
    const missingMigration = removed.find(
      (item) => item.status.issueCount > 0 && !item.targetId,
    );
    if (missingMigration) {
      setError(
        `Select where to migrate ${missingMigration.status.issueCount} issue${missingMigration.status.issueCount === 1 ? "" : "s"} from ${missingMigration.status.name}.`,
      );
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/workflow`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: view.workflow.version,
            statuses: statuses.map((status) => ({
              id: status.id,
              name: status.name,
              category: status.category,
              color: status.color,
              columnId: status.columnId,
            })),
            transitions: transitions.map((transition) => ({
              fromStatusId: transition.fromStatusId,
              toStatusId: transition.toStatusId,
            })),
            removedStatusMigrations: removed
              .filter((item) => item.targetId)
              .map((item) => ({
                fromStatusId: item.status.id,
                toStatusId: item.targetId,
              })),
          }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not update the workflow."));
      }
      const updated = body as WorkflowSettingsView;
      setView(updated);
      setStatuses(updated.statuses);
      setTransitions(
        updated.transitions.map((transition) => ({ ...transition })),
      );
      setRemoved([]);
      setPersistedStatusIds(
        new Set(updated.statuses.map((status) => status.id)),
      );
      onColumnsChanged(updated.columns);
      setNotice(`Workflow version ${updated.workflow.version} is now active.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update the workflow.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="workflow-settings" aria-labelledby="workflow-title">
      <div className="workflow-heading">
        <div>
          <h2 id="workflow-title">Workflow</h2>
          <p className="muted">
            Version {view.workflow.version}. Configure statuses, column
            projection, and allowed directed transitions atomically.
          </p>
        </div>
        <button
          className="secondary-button"
          disabled={pending || statuses.length >= 20}
          onClick={addStatus}
          type="button"
        >
          Add status
        </button>
      </div>
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
        <table className="member-table workflow-status-table">
          <caption className="sr-only">Active workflow statuses</caption>
          <thead>
            <tr>
              <th scope="col">Order and name</th>
              <th scope="col">Category</th>
              <th scope="col">Color</th>
              <th scope="col">Board column</th>
              <th scope="col">Usage</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((status, index) => (
              <tr key={status.id}>
                <td>
                  <div className="workflow-order-actions">
                    <button
                      aria-label={`Move ${status.name} earlier`}
                      className="text-button"
                      disabled={pending || index === 0}
                      onClick={() => moveStatus(status.id, -1)}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${status.name} later`}
                      className="text-button"
                      disabled={pending || index === statuses.length - 1}
                      onClick={() => moveStatus(status.id, 1)}
                      type="button"
                    >
                      ↓
                    </button>
                    <label>
                      <span className="sr-only">Status name</span>
                      <input
                        aria-label={`Name for ${status.name}`}
                        disabled={pending}
                        maxLength={60}
                        value={status.name}
                        onChange={(event) =>
                          updateStatus(status.id, { name: event.target.value })
                        }
                      />
                    </label>
                  </div>
                </td>
                <td>
                  <label>
                    <span className="sr-only">Category for {status.name}</span>
                    <select
                      aria-label={`Category for ${status.name}`}
                      disabled={pending}
                      value={status.category}
                      onChange={(event) =>
                        updateStatus(status.id, {
                          category: event.target.value as StatusCategory,
                        })
                      }
                    >
                      <option value="TODO">To do</option>
                      <option value="IN_PROGRESS">In progress</option>
                      <option value="DONE">Done</option>
                    </select>
                  </label>
                </td>
                <td>
                  <input
                    aria-label={`Color for ${status.name}`}
                    disabled={pending}
                    type="color"
                    value={status.color}
                    onChange={(event) =>
                      updateStatus(status.id, { color: event.target.value })
                    }
                  />
                </td>
                <td>
                  <select
                    aria-label={`Board column for ${status.name}`}
                    disabled={pending}
                    value={status.columnId}
                    onChange={(event) =>
                      updateStatus(status.id, { columnId: event.target.value })
                    }
                  >
                    {view.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{status.issueCount} issues</td>
                <td>
                  <button
                    className="danger-button"
                    disabled={pending || statuses.length <= 3}
                    onClick={() => removeStatus(status)}
                    type="button"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {removed.length > 0 && (
        <div className="removed-statuses">
          <h3>Pending status removals</h3>
          {removed.map((item) => (
            <div key={item.status.id}>
              <span>
                {item.status.name} · {item.status.issueCount} issues
              </span>
              {item.status.issueCount > 0 && (
                <label>
                  Migrate issues to
                  <select
                    disabled={pending}
                    required
                    value={item.targetId}
                    onChange={(event) =>
                      setRemoved((current) =>
                        current.map((removedStatus) =>
                          removedStatus.status.id === item.status.id
                            ? {
                                ...removedStatus,
                                targetId: event.target.value,
                              }
                            : removedStatus,
                        ),
                      )
                    }
                  >
                    <option value="">Select a target</option>
                    {statuses.map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="workflow-heading">
        <div>
          <h3>Allowed transitions</h3>
          <p className="muted">Each edge is directional.</p>
        </div>
        <button
          className="secondary-button"
          disabled={pending || statuses.length < 2}
          onClick={addTransition}
          type="button"
        >
          Add transition
        </button>
      </div>
      <div className="workflow-transition-list">
        {transitions.length === 0 && (
          <p className="empty-state">No transitions are configured.</p>
        )}
        {transitions.map((transition, index) => (
          <div key={transition.id}>
            <label>
              From
              <select
                aria-label={`Transition ${index + 1} from`}
                disabled={pending}
                value={transition.fromStatusId}
                onChange={(event) =>
                  setTransitions((current) =>
                    current.map((item) =>
                      item.id === transition.id
                        ? { ...item, fromStatusId: event.target.value }
                        : item,
                    ),
                  )
                }
              >
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </label>
            <span aria-hidden="true">→</span>
            <label>
              To
              <select
                aria-label={`Transition ${index + 1} to`}
                disabled={pending}
                value={transition.toStatusId}
                onChange={(event) =>
                  setTransitions((current) =>
                    current.map((item) =>
                      item.id === transition.id
                        ? { ...item, toStatusId: event.target.value }
                        : item,
                    ),
                  )
                }
              >
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() =>
                setTransitions((current) =>
                  current.filter((item) => item.id !== transition.id),
                )
              }
              type="button"
            >
              Remove transition
            </button>
          </div>
        ))}
      </div>
      <button
        className="primary-button"
        disabled={pending}
        onClick={() => void save()}
        type="button"
      >
        {pending ? "Saving workflow…" : "Save workflow"}
      </button>
    </section>
  );
}
