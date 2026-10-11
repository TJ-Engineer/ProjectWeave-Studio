"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type {
  BoardColumnView,
  BoardView,
  IssueDetailView,
  IssueView,
  Priority,
  ProjectMemberView,
} from "@vibe/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LogoutButton } from "./logout-button";

function apiMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  )
    return body.error.message;
  return fallback;
}

export function Board({
  initialBoard,
  initialSelected,
  displayName,
  canEditIssues,
}: {
  initialBoard: BoardView;
  initialSelected: IssueDetailView | null;
  displayName: string;
  canEditIssues: boolean;
}) {
  const [board, setBoard] = useState(initialBoard);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<IssueDetailView | null>(
    initialSelected,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const visibleIssues = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? board.issues.filter(
          (issue) =>
            issue.key.toLowerCase().includes(query) ||
            issue.summary.toLowerCase().includes(query),
        )
      : board.issues;
  }, [board.issues, search]);

  async function refreshDetail(issueKey: string) {
    const response = await fetch(`/api/v1/issues/${issueKey}`);
    if (response.ok) {
      setSelected((await response.json()) as IssueDetailView);
      window.history.replaceState(null, "", `?issue=${issueKey}`);
    }
  }

  async function move(issue: IssueView, destination: BoardColumnView) {
    if (destination.statusIds.includes(issue.statusId)) {
      setNotice(`${issue.key} is already in ${destination.name}.`);
      return;
    }
    const transition = issue.allowedTransitions.find((item) =>
      destination.statusIds.includes(item.toStatusId),
    );
    if (!transition) {
      setNotice(
        `The workflow does not allow ${issue.key} to move to ${destination.name}.`,
      );
      return;
    }
    const destinationIssues = board.issues.filter((item) =>
      destination.statusIds.includes(item.statusId),
    );
    const destinationRank =
      Math.max(0, ...destinationIssues.map((item) => item.rank)) + 1024;
    const previous = board;
    const optimistic: IssueView = {
      ...issue,
      statusId: transition.toStatusId,
      rank: destinationRank,
      version: issue.version + 1,
      allowedTransitions: [],
    };
    setBoard({
      ...board,
      issues: board.issues.map((item) =>
        item.id === issue.id ? optimistic : item,
      ),
    });
    setNotice(`Moving ${issue.key}…`);

    const response = await fetch(`/api/v1/issues/${issue.key}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transitionId: transition.id,
        destinationStatusId: transition.toStatusId,
        destinationRank,
        version: issue.version,
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      setBoard(previous);
      setNotice(apiMessage(body, `Could not move ${issue.key}.`));
      return;
    }
    const canonical = body as IssueView;
    setBoard((current) => ({
      ...current,
      issues: current.issues.map((item) =>
        item.id === issue.id ? canonical : item,
      ),
    }));
    setNotice(`${issue.key} moved to ${destination.name}.`);
    if (selected?.id === issue.id) await refreshDetail(issue.key);
  }

  function handleDragEnd(event: DragEndEvent) {
    const issue = board.issues.find((item) => item.id === event.active.id);
    const destination = board.columns.find(
      (column) => column.id === event.over?.id,
    );
    if (issue && destination) void move(issue, destination);
  }

  async function createIssue(input: {
    summary: string;
    description: string;
    priority: string;
  }) {
    const response = await fetch(
      `/api/v1/projects/${board.project.key}/issues`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, issueType: "TASK" }),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(apiMessage(body, "Could not create issue"));
    const issue = body as IssueView;
    setBoard((current) => ({ ...current, issues: [...current.issues, issue] }));
    setNotice(`${issue.key} created.`);
    setCreating(false);
  }

  async function saveIssue(
    issue: IssueDetailView,
    input: {
      summary: string;
      description: string;
      priority: Priority;
      assigneeId: string | null;
    },
  ) {
    const response = await fetch(`/api/v1/issues/${issue.key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, version: issue.version }),
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(apiMessage(body, `Could not update ${issue.key}.`));
    const canonical = body as IssueDetailView;
    setBoard((current) => ({
      ...current,
      issues: current.issues.map((item) =>
        item.id === canonical.id ? canonical : item,
      ),
    }));
    setSelected(canonical);
    setNotice(`${canonical.key} updated.`);
  }

  return (
    <main className="board-shell">
      <header className="topbar board-topbar">
        <div className="board-breadcrumbs">
          <Link className="brand" href="/projects">
            <span>V</span> Vibe JIRA
          </Link>
          <span aria-hidden="true">/</span>
          <strong>{board.project.name}</strong>
        </div>
        <div className="user-actions">
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="board-toolbar" aria-labelledby="board-title">
        <div>
          <p className="eyebrow">{board.project.key} · Kanban</p>
          <h1 id="board-title">{board.name}</h1>
        </div>
        <div className="toolbar-actions">
          <label className="search-field">
            <span className="sr-only">Filter issues</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter issues…"
            />
          </label>
          <button
            className="primary-button"
            type="button"
            onClick={() => setCreating(true)}
          >
            + Create task
          </button>
        </div>
      </section>
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="board-grid">
          {board.columns.map((column, columnIndex) => {
            const issues = visibleIssues
              .filter((issue) => column.statusIds.includes(issue.statusId))
              .sort((a, b) => a.rank - b.rank);
            return (
              <BoardColumn
                column={column}
                issues={issues}
                key={column.id}
                onOpen={(issue) => void refreshDetail(issue.key)}
                onMove={(issue, direction) => {
                  const target = board.columns[columnIndex + direction];
                  if (target) void move(issue, target);
                }}
                hasPrevious={columnIndex > 0}
                hasNext={columnIndex < board.columns.length - 1}
              />
            );
          })}
        </div>
      </DndContext>
      {creating && (
        <CreateIssueDialog
          onClose={() => setCreating(false)}
          onCreate={createIssue}
        />
      )}
      {selected && (
        <IssueDrawer
          issue={selected}
          board={board}
          canEdit={canEditIssues}
          onSave={(input) => saveIssue(selected, input)}
          onReload={() => refreshDetail(selected.key)}
          onClose={() => {
            setSelected(null);
            window.history.replaceState(null, "", window.location.pathname);
          }}
        />
      )}
    </main>
  );
}

function BoardColumn({
  column,
  issues,
  onOpen,
  onMove,
  hasPrevious,
  hasNext,
}: {
  column: BoardColumnView;
  issues: IssueView[];
  onOpen: (issue: IssueView) => void;
  onMove: (issue: IssueView, direction: -1 | 1) => void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const overLimit = column.wipLimit !== null && issues.length > column.wipLimit;
  return (
    <section
      ref={setNodeRef}
      className={`board-column ${isOver ? "is-over" : ""}`}
      aria-labelledby={`column-${column.id}`}
    >
      <header>
        <h2 id={`column-${column.id}`}>{column.name}</h2>
        <span className={overLimit ? "count over-limit" : "count"}>
          {issues.length}
        </span>
      </header>
      <div className="card-list">
        {issues.length === 0 && <p className="empty-column">Drop work here</p>}
        {issues.map((issue) => (
          <IssueCard
            issue={issue}
            key={issue.id}
            onOpen={() => onOpen(issue)}
            {...(hasPrevious ? { onPrevious: () => onMove(issue, -1) } : {})}
            {...(hasNext ? { onNext: () => onMove(issue, 1) } : {})}
          />
        ))}
      </div>
    </section>
  );
}

function IssueCard({
  issue,
  onOpen,
  onPrevious,
  onNext,
}: {
  issue: IssueView;
  onOpen: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: issue.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`issue-card ${isDragging ? "is-dragging" : ""}`}
    >
      <div className="card-heading">
        <button className="issue-summary" type="button" onClick={onOpen}>
          {issue.summary}
        </button>
        <button
          ref={setActivatorNodeRef}
          className="drag-handle"
          type="button"
          aria-label={`Drag ${issue.key}`}
          {...listeners}
          {...attributes}
        >
          ⠿
        </button>
      </div>
      <div className="card-metadata">
        <span className={`priority ${issue.priority.toLowerCase()}`}>
          {issue.priority}
        </span>
        <span>{issue.key}</span>
      </div>
      <div className="card-controls">
        {onPrevious && (
          <button
            type="button"
            onClick={onPrevious}
            aria-label={`Move ${issue.key} to previous column`}
          >
            ←
          </button>
        )}
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            aria-label={`Move ${issue.key} to next column`}
          >
            →
          </button>
        )}
      </div>
    </article>
  );
}

function CreateIssueDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    summary: string;
    description: string;
    priority: string;
  }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await onCreate({
        summary: String(form.get("summary") ?? ""),
        description: String(form.get("description") ?? ""),
        priority: String(form.get("priority") ?? "MEDIUM"),
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create issue",
      );
      setPending(false);
    }
  }
  return (
    <dialog ref={dialog} className="issue-dialog" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <div>
          <p className="eyebrow">New work</p>
          <h2>Create task</h2>
        </div>
        <label>
          Summary
          <input name="summary" maxLength={200} required />
        </label>
        <label>
          Description
          <textarea name="description" rows={5} maxLength={20000} />
        </label>
        <label>
          Priority
          <select name="priority" defaultValue="MEDIUM">
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
            <option>CRITICAL</option>
          </select>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function IssueDrawer({
  issue,
  board,
  canEdit,
  onSave,
  onReload,
  onClose,
}: {
  issue: IssueDetailView;
  board: BoardView;
  canEdit: boolean;
  onSave: (input: {
    summary: string;
    description: string;
    priority: Priority;
    assigneeId: string | null;
  }) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const statusName = (id: unknown) =>
    board.statuses.find((status) => status.id === id)?.name ?? "Unknown";
  return (
    <aside
      className="issue-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-drawer-title"
    >
      <header>
        <span className="eyebrow">
          {issue.key} · {issue.issueType}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close issue details"
        >
          ×
        </button>
      </header>
      <div className="drawer-title-row">
        <h2 id="issue-drawer-title">{issue.summary}</h2>
        {canEdit && !editing && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => setEditing(true)}
          >
            Edit issue
          </button>
        )}
      </div>
      {editing ? (
        <EditIssueForm
          key={`${issue.id}:${issue.version}`}
          issue={issue}
          members={board.members}
          onCancel={() => setEditing(false)}
          onReload={onReload}
          onSave={async (input) => {
            await onSave(input);
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="description">
            {issue.description || "No description yet."}
          </p>
          <dl className="issue-fields">
            <div>
              <dt>Status</dt>
              <dd>{statusName(issue.statusId)}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{issue.priority}</dd>
            </div>
            <div>
              <dt>Assignee</dt>
              <dd>{issue.assignee?.displayName ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt>Reporter</dt>
              <dd>{issue.reporter.displayName}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{issue.version}</dd>
            </div>
          </dl>
        </>
      )}
      <h3>Activity</h3>
      <ol className="timeline">
        {[...issue.events].reverse().map((event) => (
          <li key={event.id}>
            <strong>{event.actorName}</strong>{" "}
            {event.eventType === "CREATED"
              ? "created this issue"
              : event.eventType === "TRANSITIONED"
                ? `moved it from ${statusName(event.payload.fromStatusId)} to ${statusName(event.payload.toStatusId)}`
                : updateEventText(event.payload)}
            <time>{new Date(event.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function EditIssueForm({
  issue,
  members,
  onSave,
  onReload,
  onCancel,
}: {
  issue: IssueDetailView;
  members: ProjectMemberView[];
  onSave: (input: {
    summary: string;
    description: string;
    priority: Priority;
    assigneeId: string | null;
  }) => Promise<void>;
  onReload: () => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const assigneeId = String(form.get("assigneeId") ?? "");
    try {
      await onSave({
        summary: String(form.get("summary") ?? ""),
        description: String(form.get("description") ?? ""),
        priority: String(form.get("priority") ?? "MEDIUM") as Priority,
        assigneeId: assigneeId || null,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update issue",
      );
      setPending(false);
    }
  }

  return (
    <form className="stack-form drawer-edit-form" onSubmit={submit}>
      <h3>Edit issue</h3>
      <label>
        Summary
        <input
          name="summary"
          defaultValue={issue.summary}
          maxLength={200}
          required
        />
      </label>
      <label>
        Description
        <textarea
          name="description"
          defaultValue={issue.description}
          rows={6}
          maxLength={20000}
        />
      </label>
      <label>
        Priority
        <select name="priority" defaultValue={issue.priority}>
          <option>LOW</option>
          <option>MEDIUM</option>
          <option>HIGH</option>
          <option>CRITICAL</option>
        </select>
      </label>
      <label>
        Assignee
        <select name="assigneeId" defaultValue={issue.assignee?.id ?? ""}>
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="edit-error" role="alert">
          <p className="form-error">{error}</p>
          <button
            className="text-button"
            type="button"
            onClick={() => void onReload()}
          >
            Reload latest issue
          </button>
        </div>
      )}
      <div className="dialog-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button className="primary-button" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function updateEventText(payload: Record<string, unknown>): string {
  const fields = Array.isArray(payload.fields)
    ? payload.fields.filter(
        (field): field is string => typeof field === "string",
      )
    : [];
  if (fields.length === 0) return "updated this issue";
  if (fields.length === 1) return `updated ${fields[0]}`;
  if (fields.length === 2) return `updated ${fields[0]} and ${fields[1]}`;
  return `updated ${fields.slice(0, -1).join(", ")}, and ${fields.at(-1)}`;
}
