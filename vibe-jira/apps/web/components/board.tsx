"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  AttachmentView,
  BoardColumnView,
  BoardIssuePage,
  BoardView,
  IssueCollaborationView,
  IssueDetailView,
  IssueType,
  IssueView,
  Priority,
  QuickFilterView,
  SwimlaneMode,
  TransitionView,
} from "@vibe/contracts";
import { boardChangeEventSchema } from "@vibe/contracts";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  acceptBoardChange,
  boardVersions,
  mergeBoardVersions,
} from "@/lib/board-realtime";
import { boardSwimlanes } from "@/lib/board-swimlanes";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";
import { MarkdownText } from "./markdown-text";

const issueTypes: IssueType[] = ["EPIC", "STORY", "TASK", "BUG", "SUBTASK"];

function parentCandidates(
  issues: IssueView[],
  issueType: IssueType,
  currentIssueId?: string,
): IssueView[] {
  const parentTypes: IssueType[] =
    issueType === "SUBTASK"
      ? ["STORY", "TASK", "BUG"]
      : issueType === "EPIC"
        ? []
        : ["EPIC"];
  return issues.filter(
    (issue) =>
      issue.id !== currentIssueId && parentTypes.includes(issue.issueType),
  );
}

function parseLabels(value: string): string[] {
  const labels = new Map<string, string>();
  for (const rawLabel of value.split(",")) {
    const label = rawLabel.trim().replace(/\s+/g, " ");
    if (label) labels.set(label.toLocaleLowerCase(), label);
  }
  return [...labels.values()];
}

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

const rankScale = 10n ** 10n;

function rankUnits(rank: string): bigint {
  const [whole = "0", fraction = ""] = rank.split(".");
  return (
    BigInt(whole) * rankScale +
    BigInt(fraction.padEnd(10, "0").slice(0, 10) || "0")
  );
}

function compareIssuesByRank(left: IssueView, right: IssueView): number {
  const leftRank = rankUnits(left.rank);
  const rightRank = rankUnits(right.rank);
  if (leftRank < rightRank) return -1;
  if (leftRank > rightRank) return 1;
  return left.id.localeCompare(right.id);
}

function replaceUrlParameter(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export interface BoardFilterState {
  q: string;
  issueType: "" | IssueType;
  priority: "" | Priority;
  assignee: string;
  label: string;
  epicKey: string;
}

function boardFilterParameters(
  filters: BoardFilterState,
  cursor?: string,
): URLSearchParams {
  const parameters = new URLSearchParams({ limit: "50" });
  if (cursor) parameters.set("cursor", cursor);
  if (filters.q.trim()) parameters.set("q", filters.q.trim());
  if (filters.issueType) parameters.set("issueType", filters.issueType);
  if (filters.priority) parameters.set("priority", filters.priority);
  if (filters.assignee) parameters.set("assignee", filters.assignee);
  if (filters.label.trim()) parameters.set("label", filters.label.trim());
  if (filters.epicKey.trim()) parameters.set("epicKey", filters.epicKey.trim());
  return parameters;
}

function replaceFilterUrl(filters: BoardFilterState): void {
  const url = new URL(window.location.href);
  const entries: Array<[string, string]> = [
    ["q", filters.q.trim()],
    ["type", filters.issueType],
    ["priority", filters.priority],
    ["assignee", filters.assignee],
    ["label", filters.label.trim()],
    ["epic", filters.epicKey.trim().toUpperCase()],
  ];
  for (const [name, value] of entries) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function quickFilterHref(
  board: BoardView,
  quickFilter: QuickFilterView,
  swimlane: SwimlaneMode,
): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of [
    ["q", quickFilter.query.q],
    ["type", quickFilter.query.issueType],
    ["priority", quickFilter.query.priority],
    ["assignee", quickFilter.query.assignee],
    ["label", quickFilter.query.label],
    ["epic", quickFilter.query.epicKey],
    ["swimlane", swimlane === "none" ? "" : swimlane],
  ] as const) {
    if (value) parameters.set(name, value);
  }
  const query = parameters.toString();
  return `/projects/${board.project.key}/boards/${board.id}${query ? `?${query}` : ""}`;
}

export function Board({
  initialBoard,
  initialSelected,
  initialSwimlane,
  initialFilters,
  quickFilters,
  displayName,
  canEditIssues,
  canDeleteIssues,
  canCreateIssues,
  canTransitionIssues,
  canComment,
  canWatch,
  canAttach,
  canManageProject,
}: {
  initialBoard: BoardView;
  initialSelected: IssueDetailView | null;
  initialSwimlane: SwimlaneMode;
  initialFilters: BoardFilterState;
  quickFilters: QuickFilterView[];
  displayName: string;
  canEditIssues: boolean;
  canDeleteIssues: boolean;
  canCreateIssues: boolean;
  canTransitionIssues: boolean;
  canComment: boolean;
  canWatch: boolean;
  canAttach: boolean;
  canManageProject: boolean;
}) {
  const [board, setBoard] = useState(initialBoard);
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState(initialFilters);
  const filtersRef = useRef(initialFilters);
  const [filtering, setFiltering] = useState(false);
  const [swimlane, setSwimlane] = useState(initialSwimlane);
  const [liveState, setLiveState] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<IssueDetailView | null>(
    initialSelected,
  );
  const versions = useRef(boardVersions(initialBoard));
  const selectedKey = useRef(initialSelected?.key ?? null);
  const realtimeRefreshActive = useRef(false);
  const realtimeRefreshQueued = useRef(false);
  const filterInitialized = useRef(false);
  const filterGeneration = useRef(0);
  const [windowedColumns, setWindowedColumns] = useState<Set<string>>(
    () => new Set(),
  );
  const [pagingColumn, setPagingColumn] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const lanes = useMemo(
    () => boardSwimlanes(board, board.issues, swimlane),
    [board, swimlane],
  );

  const refreshDetail = useCallback(async (issueKey: string) => {
    const response = await fetch(`/api/v1/issues/${issueKey}`);
    if (response.ok) {
      if (selectedKey.current !== issueKey) return;
      setSelected((await response.json()) as IssueDetailView);
      replaceUrlParameter("issue", issueKey);
    }
  }, []);

  const openIssue = useCallback(
    (issueKey: string) => {
      selectedKey.current = issueKey;
      void refreshDetail(issueKey);
    },
    [refreshDetail],
  );

  function issuesInColumn(column: BoardColumnView): IssueView[] {
    return board.issues
      .filter((item) => column.statusIds.includes(item.statusId))
      .sort(compareIssuesByRank);
  }

  const refreshBoard = useCallback(async (): Promise<BoardView | null> => {
    const generation = filterGeneration.current;
    const parameters = boardFilterParameters(filtersRef.current);
    const response = await fetch(
      `/api/v1/boards/${board.id}/issues?${parameters.toString()}`,
    );
    if (!response.ok) return null;
    const canonical = (await response.json()) as BoardView;
    if (generation !== filterGeneration.current) return null;
    mergeBoardVersions(versions.current, canonical);
    setBoard(canonical);
    setWindowedColumns(new Set());
    return canonical;
  }, [board.id]);

  const scheduleRealtimeRefresh = useCallback(() => {
    if (realtimeRefreshActive.current) {
      realtimeRefreshQueued.current = true;
      return;
    }
    realtimeRefreshActive.current = true;
    void (async () => {
      do {
        realtimeRefreshQueued.current = false;
        const canonical = await refreshBoard();
        const issueKey = selectedKey.current;
        if (
          canonical &&
          issueKey &&
          canonical.issues.some((issue) => issue.key === issueKey)
        ) {
          await refreshDetail(issueKey);
        }
      } while (realtimeRefreshQueued.current);
    })().finally(() => {
      realtimeRefreshActive.current = false;
    });
  }, [refreshBoard, refreshDetail]);

  useEffect(() => {
    selectedKey.current = selected?.key ?? null;
  }, [selected]);

  useEffect(() => {
    mergeBoardVersions(versions.current, board);
  }, [board]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    replaceFilterUrl(filters);
    if (!filterInitialized.current) {
      filterInitialized.current = true;
      return;
    }
    const generation = ++filterGeneration.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFiltering(true);
      const parameters = boardFilterParameters(filters);
      void fetch(`/api/v1/boards/${board.id}/issues?${parameters.toString()}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not filter the board");
          const canonical = (await response.json()) as BoardView;
          if (generation !== filterGeneration.current) return;
          mergeBoardVersions(versions.current, canonical);
          setBoard(canonical);
          setWindowedColumns(new Set());
          setNotice("");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setNotice(
            error instanceof Error
              ? error.message
              : "Could not filter the board",
          );
        })
        .finally(() => {
          if (generation === filterGeneration.current) setFiltering(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [board.id, filters]);

  useEffect(() => {
    const source = new EventSource(`/api/v1/boards/${board.id}/events`);
    source.onopen = () => setLiveState("connected");
    source.onerror = () => setLiveState("reconnecting");
    source.addEventListener("board.sync", scheduleRealtimeRefresh);
    source.addEventListener("board.changed", (message) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse((message as MessageEvent<string>).data) as unknown;
      } catch {
        return;
      }
      const parsed = boardChangeEventSchema.safeParse(payload);
      if (
        parsed.success &&
        acceptBoardChange(board.project.id, versions.current, parsed.data)
      ) {
        scheduleRealtimeRefresh();
      }
    });
    return () => source.close();
  }, [board.id, board.project.id, scheduleRealtimeRefresh]);

  async function move(
    issue: IssueView,
    destination: BoardColumnView,
    beforeIssueId: string | null,
    afterIssueId: string | null,
    requestedStatusId?: string,
  ) {
    const sameColumn = destination.statusIds.includes(issue.statusId);
    const destinationStatusId =
      requestedStatusId ??
      (sameColumn
        ? issue.statusId
        : issue.allowedTransitions.find((item) =>
            destination.statusIds.includes(item.toStatusId),
          )?.toStatusId) ??
      issue.statusId;
    const reordered = destinationStatusId === issue.statusId;
    const transition = reordered
      ? null
      : issue.allowedTransitions.find(
          (item) => item.toStatusId === destinationStatusId,
        );
    if (!reordered && !transition) {
      setNotice(
        `The workflow does not allow ${issue.key} to move to ${destination.name}.`,
      );
      return;
    }
    if (!sameColumn && reordered) {
      setNotice(
        `The workflow does not allow ${issue.key} to move to ${destination.name}.`,
      );
      return;
    }
    const currentColumn = board.columns.find((column) =>
      column.statusIds.includes(issue.statusId),
    );
    if (reordered && currentColumn) {
      const currentNeighbors = board.issueNeighbors[issue.id];
      const currentBefore = currentNeighbors?.previousIssueId ?? null;
      const currentAfter = currentNeighbors?.nextIssueId ?? null;
      if (beforeIssueId === currentBefore && afterIssueId === currentAfter) {
        setNotice(`${issue.key} is already in that position.`);
        return;
      }
    }
    setNotice(`${reordered ? "Reordering" : "Moving"} ${issue.key}…`);

    const response = await fetch(`/api/v1/issues/${issue.key}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transitionId: transition?.id ?? null,
        destinationColumnId: destination.id,
        destinationStatusId,
        beforeIssueId,
        afterIssueId,
        version: issue.version,
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      await refreshBoard();
      setNotice(apiMessage(body, `Could not move ${issue.key}.`));
      return;
    }
    const canonical = await refreshBoard();
    if (!canonical) {
      setNotice(`${issue.key} moved, but the board could not be refreshed.`);
      return;
    }
    setNotice(
      reordered
        ? `${issue.key} reordered in ${destination.name}.`
        : `${issue.key} moved to ${
            board.statuses.find((status) => status.id === destinationStatusId)
              ?.name ?? destination.name
          }.`,
    );
    if (selected?.id === issue.id) await refreshDetail(issue.key);
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!canTransitionIssues) return;
    const issue = board.issues.find((item) => item.id === event.active.id);
    if (!issue || !event.over) return;
    const overIssue = board.issues.find((item) => item.id === event.over?.id);
    const overColumnId = event.over.data.current?.columnId;
    const destination = overIssue
      ? board.columns.find((column) =>
          column.statusIds.includes(overIssue.statusId),
        )
      : board.columns.find(
          (column) =>
            column.id === overColumnId || column.id === event.over?.id,
        );
    if (!destination || overIssue?.id === issue.id) return;

    let beforeIssueId =
      destination.tailIssueId === issue.id
        ? destination.penultimateIssueId
        : destination.tailIssueId;
    let afterIssueId: string | null = null;
    if (overIssue) {
      const movingDown =
        destination.statusIds.includes(issue.statusId) &&
        compareIssuesByRank(issue, overIssue) < 0;
      if (movingDown) {
        beforeIssueId = overIssue.id;
        afterIssueId = board.issueNeighbors[overIssue.id]?.nextIssueId ?? null;
      } else {
        beforeIssueId =
          board.issueNeighbors[overIssue.id]?.previousIssueId ?? null;
        afterIssueId = overIssue.id;
      }
    }
    void move(issue, destination, beforeIssueId, afterIssueId);
  }

  async function loadColumnPage(columnId: string, reset = false) {
    const currentPage = board.columnPages.find(
      (page) => page.columnId === columnId,
    );
    if (!reset && !currentPage?.nextCursor) return;
    setPagingColumn(columnId);
    try {
      const parameters = boardFilterParameters(
        filters,
        reset ? undefined : (currentPage?.nextCursor ?? undefined),
      );
      const response = await fetch(
        `/api/v1/boards/${board.id}/columns/${columnId}/issues?${parameters.toString()}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        setNotice(apiMessage(body, "Could not load more issues."));
        return;
      }
      const page = body as BoardIssuePage;
      const column = board.columns.find((item) => item.id === columnId);
      if (!column) return;
      const loadedBefore = issuesInColumn(column).length;
      const shouldReplace = reset || loadedBefore + page.items.length > 100;
      setBoard((current) => {
        const currentColumn = current.columns.find(
          (item) => item.id === columnId,
        );
        if (!currentColumn) return current;
        const otherIssues = current.issues.filter(
          (issue) => !currentColumn.statusIds.includes(issue.statusId),
        );
        const loadedIssues = current.issues.filter((issue) =>
          currentColumn.statusIds.includes(issue.statusId),
        );
        const nextIssues = shouldReplace
          ? page.items
          : [...loadedIssues, ...page.items].filter(
              (issue, index, items) =>
                items.findIndex((candidate) => candidate.id === issue.id) ===
                index,
            );
        return {
          ...current,
          issues: [...otherIssues, ...nextIssues],
          issueNeighbors: {
            ...current.issueNeighbors,
            ...page.issueNeighbors,
          },
          columnPages: current.columnPages.map((item) =>
            item.columnId === columnId
              ? { ...item, total: page.total, nextCursor: page.nextCursor }
              : item,
          ),
        };
      });
      setWindowedColumns((current) => {
        const next = new Set(current);
        if (reset) next.delete(columnId);
        else if (shouldReplace) next.add(columnId);
        return next;
      });
      setNotice(
        reset ? "Returned to the first issue window." : "More issues loaded.",
      );
    } finally {
      setPagingColumn(null);
    }
  }

  async function createIssue(
    input: {
      summary: string;
      description: string;
      priority: Priority;
      issueType: IssueType;
      assigneeId: string | null;
      labels: string[];
      parentIssueKey: string | null;
      estimatePoints: number | null;
      dueDate: string | null;
    },
    idempotencyKey: string,
  ) {
    const response = await fetch(
      `/api/v1/projects/${board.project.key}/issues`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(apiMessage(body, "Could not create issue"));
    const issue = body as IssueView;
    await refreshBoard();
    setNotice(`${issue.key} created.`);
    setCreating(false);
  }

  async function saveIssue(
    issue: IssueDetailView,
    input: {
      summary: string;
      description: string;
      priority: Priority;
      issueType: IssueType;
      assigneeId: string | null;
      labels: string[];
      parentIssueKey: string | null;
      estimatePoints: number | null;
      dueDate: string | null;
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
    await refreshBoard();
    setSelected(canonical);
    setNotice(`${canonical.key} updated.`);
  }

  async function removeIssue(issue: IssueDetailView) {
    const response = await fetch(`/api/v1/issues/${issue.key}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: issue.version }),
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      throw new Error(apiMessage(body, `Could not delete ${issue.key}.`));
    }
    await refreshBoard();
    selectedKey.current = null;
    setSelected(null);
    replaceUrlParameter("issue", null);
    setNotice(`${issue.key} moved to deleted issues.`);
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
          <SearchLink />
          <NotificationLink />
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
          <span className={`live-status ${liveState}`} aria-live="polite">
            Live updates {liveState}
          </span>
          <label className="swimlane-field">
            <span>Swimlanes</span>
            <select
              aria-label="Swimlanes"
              value={swimlane}
              onChange={(event) => {
                const mode = event.target.value as SwimlaneMode;
                setSwimlane(mode);
                replaceUrlParameter("swimlane", mode === "none" ? null : mode);
              }}
            >
              <option value="none">None</option>
              <option value="assignee">Assignee</option>
              <option value="epic">Epic</option>
            </select>
          </label>
          <Link
            className="secondary-button"
            href={`/projects/${board.project.key}/issues`}
          >
            Backlog
          </Link>
          <Link
            className="secondary-button"
            href={`/projects/${board.project.key}/reports`}
          >
            Reports
          </Link>
          {canManageProject && (
            <>
              <Link
                className="secondary-button"
                href={`/projects/${board.project.key}/settings/board`}
              >
                WIP limits
              </Link>
              <Link
                className="secondary-button"
                href={`/projects/${board.project.key}/settings/issues`}
              >
                Deleted issues
              </Link>
              <Link
                className="secondary-button"
                href={`/projects/${board.project.key}/settings/members`}
              >
                Manage members
              </Link>
              <Link
                className="secondary-button"
                href={`/projects/${board.project.key}/settings/teams`}
              >
                Team access
              </Link>
              <Link
                className="secondary-button"
                href={`/projects/${board.project.key}/settings/data`}
              >
                Import/export
              </Link>
            </>
          )}
          {canCreateIssues && (
            <button
              className="primary-button"
              type="button"
              onClick={() => setCreating(true)}
            >
              + Create issue
            </button>
          )}
        </div>
      </section>
      {quickFilters.length > 0 && (
        <nav className="quick-filter-bar" aria-label="Board quick filters">
          <span>Quick filters</span>
          {quickFilters.map((quickFilter) => (
            <Link
              className="secondary-button"
              href={quickFilterHref(board, quickFilter, swimlane)}
              key={quickFilter.id}
            >
              {quickFilter.name}
            </Link>
          ))}
        </nav>
      )}
      <section className="board-filters" aria-label="Board filters">
        <label className="search-field">
          <span>Search</span>
          <input
            value={filters.q}
            onChange={(event) =>
              setFilters((current) => ({ ...current, q: event.target.value }))
            }
            placeholder="Filter issues…"
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={filters.issueType}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                issueType: event.target.value as "" | IssueType,
              }))
            }
          >
            <option value="">All types</option>
            {issueTypes.map((issueType) => (
              <option value={issueType} key={issueType}>
                {issueType}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select
            value={filters.priority}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                priority: event.target.value as "" | Priority,
              }))
            }
          >
            <option value="">All priorities</option>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map(
              (priority) => (
                <option value={priority} key={priority}>
                  {priority}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          <span>Assignee</span>
          <select
            value={filters.assignee}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                assignee: event.target.value,
              }))
            }
          >
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {board.assignees.map((assignee) => (
              <option value={assignee.id} key={assignee.id}>
                {assignee.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Label</span>
          <input
            value={filters.label}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                label: event.target.value,
              }))
            }
            placeholder="Label"
          />
        </label>
        <label>
          <span>Epic</span>
          <input
            value={filters.epicKey}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                epicKey: event.target.value,
              }))
            }
            placeholder={`${board.project.key}-1`}
          />
        </label>
        <button
          className="text-button"
          type="button"
          disabled={filtering}
          onClick={() =>
            setFilters({
              q: "",
              issueType: "",
              priority: "",
              assignee: "",
              label: "",
              epicKey: "",
            })
          }
        >
          {filtering ? "Filtering…" : "Clear filters"}
        </button>
      </section>
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {swimlane !== "none" &&
        board.columns.some(
          (column) =>
            column.wipLimit !== null && column.issueCount > column.wipLimit,
        ) && (
          <div className="swimlane-wip-summary" role="status">
            <strong>WIP limits exceeded:</strong>{" "}
            {board.columns
              .flatMap((column) => {
                const count = column.issueCount;
                return column.wipLimit !== null && count > column.wipLimit
                  ? [`${column.name} ${count} of ${column.wipLimit}`]
                  : [];
              })
              .join("; ")}
          </div>
        )}
      <section
        className="board-window-controls"
        aria-label="Rendered issue windows"
        tabIndex={0}
      >
        {board.columns.map((column) => {
          const page = board.columnPages.find(
            (item) => item.columnId === column.id,
          );
          const loaded = issuesInColumn(column).length;
          return (
            <div key={column.id}>
              <span>
                {column.name}: showing {loaded} of {page?.total ?? 0}
                {windowedColumns.has(column.id) ? " (later window)" : ""}
              </span>
              <div>
                {windowedColumns.has(column.id) && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={pagingColumn === column.id}
                    onClick={() => void loadColumnPage(column.id, true)}
                  >
                    Back to first
                  </button>
                )}
                {page?.nextCursor && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={pagingColumn === column.id}
                    onClick={() => void loadColumnPage(column.id)}
                  >
                    {pagingColumn === column.id ? "Loading…" : "Load next 50"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className={`swimlane-list mode-${swimlane}`}>
          {lanes.map((lane) => {
            const grid = (
              <div
                className="board-grid"
                role="region"
                aria-label={
                  swimlane === "none"
                    ? "Kanban columns"
                    : `${lane.name} Kanban columns`
                }
                tabIndex={0}
              >
                {board.columns.map((column, columnIndex) => {
                  const issues = lane.issues
                    .filter((issue) =>
                      column.statusIds.includes(issue.statusId),
                    )
                    .sort(compareIssuesByRank);
                  return (
                    <BoardColumn
                      column={column}
                      issues={issues}
                      totalIssueCount={
                        swimlane === "none" ? column.issueCount : issues.length
                      }
                      showWipWarning={swimlane === "none"}
                      droppableId={`${lane.id}:${column.id}`}
                      headingId={`column-${lane.id}-${column.id}`}
                      nestedHeading={swimlane !== "none"}
                      key={column.id}
                      onOpen={(issue) => openIssue(issue.key)}
                      onMove={(issue, direction) => {
                        const target = board.columns[columnIndex + direction];
                        if (target) {
                          void move(
                            issue,
                            target,
                            target.tailIssueId === issue.id
                              ? target.penultimateIssueId
                              : target.tailIssueId,
                            null,
                          );
                        }
                      }}
                      onOrder={(issue, laneBeforeId, laneAfterId) => {
                        if (laneBeforeId) {
                          void move(
                            issue,
                            column,
                            laneBeforeId,
                            board.issueNeighbors[laneBeforeId]?.nextIssueId ??
                              null,
                          );
                        } else if (laneAfterId) {
                          void move(
                            issue,
                            column,
                            board.issueNeighbors[laneAfterId]
                              ?.previousIssueId ?? null,
                            laneAfterId,
                          );
                        }
                      }}
                      onStatusTransition={(issue, transition) => {
                        void move(
                          issue,
                          column,
                          column.tailIssueId === issue.id
                            ? column.penultimateIssueId
                            : column.tailIssueId,
                          null,
                          transition.toStatusId,
                        );
                      }}
                      previousStatusIds={
                        board.columns[columnIndex - 1]?.statusIds ?? []
                      }
                      nextStatusIds={
                        board.columns[columnIndex + 1]?.statusIds ?? []
                      }
                      statuses={board.statuses}
                      canMove={canTransitionIssues}
                    />
                  );
                })}
              </div>
            );
            return swimlane === "none" ? (
              <div key={lane.id}>{grid}</div>
            ) : (
              <section
                className="swimlane"
                aria-labelledby={`swimlane-${lane.id}`}
                key={lane.id}
              >
                <header className="swimlane-heading">
                  <h2 id={`swimlane-${lane.id}`}>{lane.name}</h2>
                  <span className="count">{lane.issues.length}</span>
                </header>
                {grid}
              </section>
            );
          })}
        </div>
      </DndContext>
      {creating && (
        <CreateIssueDialog
          board={board}
          onClose={() => setCreating(false)}
          onCreate={createIssue}
        />
      )}
      {selected && (
        <IssueDrawer
          issue={selected}
          board={board}
          canEdit={canEditIssues}
          canDelete={canDeleteIssues}
          canComment={canComment}
          canWatch={canWatch}
          canAttach={canAttach}
          onDelete={() => removeIssue(selected)}
          onSave={(input) => saveIssue(selected, input)}
          onReload={() => refreshDetail(selected.key)}
          onClose={() => {
            selectedKey.current = null;
            setSelected(null);
            replaceUrlParameter("issue", null);
          }}
        />
      )}
    </main>
  );
}

function BoardColumn({
  column,
  issues,
  totalIssueCount,
  showWipWarning,
  droppableId,
  headingId,
  nestedHeading,
  onOpen,
  onMove,
  onOrder,
  onStatusTransition,
  previousStatusIds,
  nextStatusIds,
  statuses,
  canMove,
}: {
  column: BoardColumnView;
  issues: IssueView[];
  totalIssueCount: number;
  showWipWarning: boolean;
  droppableId: string;
  headingId: string;
  nestedHeading: boolean;
  onOpen: (issue: IssueView) => void;
  onMove: (issue: IssueView, direction: -1 | 1) => void;
  onOrder: (
    issue: IssueView,
    beforeIssueId: string | null,
    afterIssueId: string | null,
  ) => void;
  onStatusTransition: (issue: IssueView, transition: TransitionView) => void;
  previousStatusIds: string[];
  nextStatusIds: string[];
  statuses: BoardView["statuses"];
  canMove: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: { columnId: column.id },
    disabled: !canMove,
  });
  const overLimit =
    showWipWarning &&
    column.wipLimit !== null &&
    totalIssueCount > column.wipLimit;
  const ColumnHeading = nestedHeading ? "h3" : "h2";
  return (
    <section
      ref={setNodeRef}
      className={`board-column ${isOver ? "is-over" : ""}`}
      aria-labelledby={headingId}
    >
      <header>
        <ColumnHeading id={headingId}>{column.name}</ColumnHeading>
        <span className={overLimit ? "count over-limit" : "count"}>
          {totalIssueCount}
        </span>
      </header>
      {overLimit && (
        <p className="wip-warning" role="status">
          WIP limit exceeded: {totalIssueCount} of {column.wipLimit}
        </p>
      )}
      <SortableContext
        items={issues.map((issue) => issue.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="card-list">
          {issues.length === 0 && (
            <p className="empty-column">Drop work here</p>
          )}
          {issues.map((issue, issueIndex) => {
            const candidates = issues.filter((item) => item.id !== issue.id);
            const sameColumnTransitions = issue.allowedTransitions.filter(
              (transition) => column.statusIds.includes(transition.toStatusId),
            );
            return (
              <IssueCard
                issue={issue}
                key={issue.id}
                canMove={canMove}
                onOpen={() => onOpen(issue)}
                {...(canMove && issueIndex > 0
                  ? {
                      onUp: () =>
                        onOrder(
                          issue,
                          candidates[issueIndex - 2]?.id ?? null,
                          candidates[issueIndex - 1]?.id ?? null,
                        ),
                    }
                  : {})}
                {...(canMove && issueIndex < issues.length - 1
                  ? {
                      onDown: () =>
                        onOrder(
                          issue,
                          candidates[issueIndex]?.id ?? null,
                          candidates[issueIndex + 1]?.id ?? null,
                        ),
                    }
                  : {})}
                statusTransitions={sameColumnTransitions.map((transition) => ({
                  id: transition.id,
                  name:
                    statuses.find(
                      (status) => status.id === transition.toStatusId,
                    )?.name ?? transition.name,
                  onMove: () => onStatusTransition(issue, transition),
                }))}
                {...(canMove &&
                issue.allowedTransitions.some((transition) =>
                  previousStatusIds.includes(transition.toStatusId),
                )
                  ? { onPrevious: () => onMove(issue, -1) }
                  : {})}
                {...(canMove &&
                issue.allowedTransitions.some((transition) =>
                  nextStatusIds.includes(transition.toStatusId),
                )
                  ? { onNext: () => onMove(issue, 1) }
                  : {})}
              />
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

function IssueCard({
  issue,
  canMove,
  onOpen,
  onUp,
  onDown,
  onPrevious,
  onNext,
  statusTransitions,
}: {
  issue: IssueView;
  canMove: boolean;
  onOpen: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  statusTransitions: Array<{ id: string; name: string; onMove: () => void }>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
    transition,
  } = useSortable({ id: issue.id, disabled: !canMove });
  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        transition,
      }
    : { transition };
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
        {canMove && (
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
        )}
      </div>
      <div className="card-metadata">
        <span className={`priority ${issue.priority.toLowerCase()}`}>
          {issue.priority}
        </span>
        <span>
          {issue.issueType} · {issue.key}
          {issue.estimatePoints !== null
            ? ` · ${issue.estimatePoints} pts`
            : ""}
        </span>
      </div>
      {issue.dueDate && (
        <small className="card-due-date">Due {issue.dueDate}</small>
      )}
      {issue.labels.length > 0 && (
        <div className="label-list" aria-label="Labels">
          {issue.labels.map((label) => (
            <span className="label-chip" key={label}>
              {label}
            </span>
          ))}
        </div>
      )}
      {canMove &&
        (onUp ||
          onDown ||
          onPrevious ||
          onNext ||
          statusTransitions.length > 0) && (
          <div className="card-controls">
            {onUp && (
              <button
                type="button"
                onClick={onUp}
                aria-label={`Move ${issue.key} up within column`}
              >
                ↑
              </button>
            )}
            {onDown && (
              <button
                type="button"
                onClick={onDown}
                aria-label={`Move ${issue.key} down within column`}
              >
                ↓
              </button>
            )}
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
            {statusTransitions.map((transition) => (
              <button
                className="status-move"
                type="button"
                onClick={transition.onMove}
                aria-label={`Move ${issue.key} to ${transition.name}`}
                key={transition.id}
              >
                {transition.name}
              </button>
            ))}
          </div>
        )}
    </article>
  );
}

function CreateIssueDialog({
  board,
  onClose,
  onCreate,
}: {
  board: BoardView;
  onClose: () => void;
  onCreate: (
    input: {
      summary: string;
      description: string;
      priority: Priority;
      issueType: IssueType;
      assigneeId: string | null;
      labels: string[];
      parentIssueKey: string | null;
      estimatePoints: number | null;
      dueDate: string | null;
    },
    idempotencyKey: string,
  ) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [issueType, setIssueType] = useState<IssueType>("TASK");
  const [parentIssueKey, setParentIssueKey] = useState("");
  const [description, setDescription] = useState("");
  const parents = parentCandidates(board.issues, issueType);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      idempotencyKey.current ??= crypto.randomUUID();
      await onCreate(
        {
          summary: String(form.get("summary") ?? ""),
          description: String(form.get("description") ?? ""),
          priority: String(form.get("priority") ?? "MEDIUM") as Priority,
          issueType,
          assigneeId: String(form.get("assigneeId") ?? "") || null,
          labels: parseLabels(String(form.get("labels") ?? "")),
          parentIssueKey: parentIssueKey || null,
          estimatePoints: form.get("estimatePoints")
            ? Number(form.get("estimatePoints"))
            : null,
          dueDate: String(form.get("dueDate") ?? "") || null,
        },
        idempotencyKey.current,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create issue",
      );
      setPending(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="issue-dialog"
      aria-labelledby="create-issue-title"
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={submit}>
        <div>
          <p className="eyebrow">New work</p>
          <h2 id="create-issue-title">Create issue</h2>
        </div>
        <label>
          Summary
          <input name="summary" maxLength={200} required />
        </label>
        <label>
          Description
          <textarea
            name="description"
            rows={5}
            maxLength={20000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {description && (
          <section
            className="markdown-preview"
            aria-label="Description preview"
          >
            <span className="eyebrow">Safe preview</span>
            <MarkdownText source={description} />
          </section>
        )}
        <label>
          Type
          <select
            name="issueType"
            value={issueType}
            onChange={(event) => {
              setIssueType(event.target.value as IssueType);
              setParentIssueKey("");
            }}
          >
            {issueTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
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
        <label>
          Assignee
          <select name="assigneeId" defaultValue="">
            <option value="">Unassigned</option>
            {board.assignees.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Parent
          <select
            name="parentIssueKey"
            value={parentIssueKey}
            required={issueType === "SUBTASK"}
            disabled={issueType === "EPIC"}
            onChange={(event) => setParentIssueKey(event.target.value)}
          >
            <option value="">
              {issueType === "SUBTASK" ? "Select a parent" : "No parent"}
            </option>
            {parents.map((issue) => (
              <option key={issue.id} value={issue.key}>
                {issue.key} · {issue.summary}
              </option>
            ))}
          </select>
        </label>
        <label>
          Labels
          <input
            name="labels"
            placeholder="frontend, customer request"
            aria-describedby="create-labels-help"
          />
          <small id="create-labels-help">
            Separate up to 20 labels with commas.
          </small>
        </label>
        <label>
          Estimate points
          <input min={0} max={1000000} name="estimatePoints" type="number" />
        </label>
        <label>
          Due date
          <input name="dueDate" type="date" />
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
  canDelete,
  canComment,
  canWatch,
  canAttach,
  onSave,
  onDelete,
  onReload,
  onClose,
}: {
  issue: IssueDetailView;
  board: BoardView;
  canEdit: boolean;
  canDelete: boolean;
  canComment: boolean;
  canWatch: boolean;
  canAttach: boolean;
  onSave: (input: {
    summary: string;
    description: string;
    priority: Priority;
    issueType: IssueType;
    assigneeId: string | null;
    labels: string[];
    parentIssueKey: string | null;
    estimatePoints: number | null;
    dueDate: string | null;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [collaboration, setCollaboration] =
    useState<IssueCollaborationView | null>(null);
  const [collaborationError, setCollaborationError] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [watching, setWatching] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentView[] | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<
    string | null
  >(null);
  const commentIdempotencyKey = useRef<string | null>(null);
  const statusName = (id: unknown) =>
    board.statuses.find((status) => status.id === id)?.name ?? "Unknown";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const drawerElement = drawer.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawerElement) return;
      const focusable = Array.from(
        drawerElement.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter(
        (element) =>
          !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        drawerElement.focus();
        return;
      }
      const currentIndex = focusable.findIndex(
        (element) => element === document.activeElement,
      );
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    closeButton.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/v1/issues/${issue.key}/comments`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load comments");
        setCollaboration((await response.json()) as IssueCollaborationView);
        setCollaborationError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCollaborationError(
          error instanceof Error ? error.message : "Could not load comments",
        );
      });
    return () => controller.abort();
  }, [issue.key, issue.version]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/v1/issues/${issue.key}/attachments`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new Error(apiMessage(body, "Could not load attachments"));
        }
        setAttachments(body as AttachmentView[]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAttachmentError(
          error instanceof Error ? error.message : "Could not load attachments",
        );
      });
    return () => controller.abort();
  }, [issue.key, issue.version]);

  async function toggleWatching() {
    if (!canWatch || !collaboration) return;
    setWatching(true);
    setCollaborationError("");
    try {
      const response = await fetch(`/api/v1/issues/${issue.key}/watch`, {
        method: collaboration.isWatching ? "DELETE" : "PUT",
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not update watcher status"));
      }
      setCollaboration(body as IssueCollaborationView);
    } catch (error) {
      setCollaborationError(
        error instanceof Error
          ? error.message
          : "Could not update watcher status",
      );
    } finally {
      setWatching(false);
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCommenting(true);
    setCollaborationError("");
    try {
      commentIdempotencyKey.current ??= crypto.randomUUID();
      const response = await fetch(`/api/v1/issues/${issue.key}/comments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": commentIdempotencyKey.current,
        },
        body: JSON.stringify({ body: commentBody }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not add comment"));
      }
      setCollaboration(body as IssueCollaborationView);
      setCommentBody("");
      commentIdempotencyKey.current = null;
      await onReload();
    } catch (error) {
      setCollaborationError(
        error instanceof Error ? error.message : "Could not add comment",
      );
    } finally {
      setCommenting(false);
    }
  }

  async function uploadAttachment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    setAttachmentError("");
    const form = event.currentTarget;
    try {
      const response = await fetch(`/api/v1/issues/${issue.key}/attachments`, {
        method: "POST",
        body: new FormData(form),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not upload attachment"));
      }
      const attachment = body as AttachmentView;
      setAttachments((current) => [...(current ?? []), attachment]);
      form.reset();
      if (attachment.scanState !== "CLEAN") {
        setAttachmentError(
          attachment.scanState === "REJECTED"
            ? "The malware scanner rejected this file."
            : "The file could not be scanned or stored. Remove it and try again.",
        );
      }
      await onReload();
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not upload attachment",
      );
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment(attachment: AttachmentView) {
    if (!window.confirm(`Remove ${attachment.filename}?`)) return;
    setDeletingAttachmentId(attachment.id);
    setAttachmentError("");
    try {
      const response = await fetch(
        `/api/v1/issues/${issue.key}/attachments/${attachment.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body: unknown = await response.json();
        throw new Error(apiMessage(body, "Could not remove attachment"));
      }
      setAttachments(
        (current) => current?.filter((item) => item.id !== attachment.id) ?? [],
      );
      await onReload();
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not remove attachment",
      );
    } finally {
      setDeletingAttachmentId(null);
    }
  }
  return (
    <aside
      ref={drawer}
      className="issue-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-drawer-title"
      tabIndex={-1}
    >
      <header>
        <span className="eyebrow">
          {issue.key} · {issue.issueType}
        </span>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="Close issue details"
        >
          ×
        </button>
      </header>
      <div className="drawer-title-row">
        <h2 id="issue-drawer-title">{issue.summary}</h2>
        {!editing && (
          <div className="drawer-title-actions">
            {canWatch && collaboration && (
              <button
                className="secondary-button"
                type="button"
                disabled={watching}
                onClick={() => void toggleWatching()}
              >
                {watching
                  ? "Saving…"
                  : collaboration.isWatching
                    ? `Unwatch (${collaboration.watcherCount})`
                    : `Watch (${collaboration.watcherCount})`}
              </button>
            )}
            {canEdit && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setEditing(true)}
              >
                Edit issue
              </button>
            )}
            {canDelete && (
              <button
                className="danger-button"
                type="button"
                disabled={deleting}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Delete ${issue.key}? A project administrator can restore it later.`,
                    )
                  ) {
                    return;
                  }
                  setDeleting(true);
                  setDeleteError("");
                  void onDelete().catch((caught: unknown) => {
                    setDeleteError(
                      caught instanceof Error
                        ? caught.message
                        : `Could not delete ${issue.key}.`,
                    );
                    setDeleting(false);
                  });
                }}
              >
                {deleting ? "Deleting…" : "Delete issue"}
              </button>
            )}
          </div>
        )}
      </div>
      {deleteError && (
        <p className="form-error settings-error" role="alert">
          {deleteError}
        </p>
      )}
      {collaborationError && (
        <p className="form-error settings-error" role="alert">
          {collaborationError}
        </p>
      )}
      {editing ? (
        <EditIssueForm
          key={`${issue.id}:${issue.version}`}
          issue={issue}
          board={board}
          onCancel={() => setEditing(false)}
          onReload={onReload}
          onSave={async (input) => {
            await onSave(input);
            setEditing(false);
          }}
        />
      ) : (
        <>
          <div className="description">
            <MarkdownText source={issue.description} />
          </div>
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
              <dt>Type</dt>
              <dd>{issue.issueType}</dd>
            </div>
            <div>
              <dt>Assignee</dt>
              <dd>{issue.assignee?.displayName ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt>Parent</dt>
              <dd>
                {issue.parent
                  ? `${issue.parent.key} · ${issue.parent.summary}`
                  : "No parent"}
              </dd>
            </div>
            <div>
              <dt>Reporter</dt>
              <dd>{issue.reporter.displayName}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{issue.version}</dd>
            </div>
            <div>
              <dt>Estimate</dt>
              <dd>
                {issue.estimatePoints === null
                  ? "Not estimated"
                  : `${issue.estimatePoints} points`}
              </dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{issue.dueDate ?? "No due date"}</dd>
            </div>
            <div className="wide-field">
              <dt>Labels</dt>
              <dd>
                {issue.labels.length > 0 ? (
                  <span className="label-list">
                    {issue.labels.map((label) => (
                      <span className="label-chip" key={label}>
                        {label}
                      </span>
                    ))}
                  </span>
                ) : (
                  "No labels"
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
      <section className="attachments" aria-labelledby="attachments-heading">
        <div className="comments-heading">
          <h3 id="attachments-heading">Attachments</h3>
          <span className="count">{attachments?.length ?? 0}</span>
        </div>
        {attachmentError && (
          <p className="form-error" role="alert">
            {attachmentError}
          </p>
        )}
        {!attachments && !attachmentError && (
          <p className="muted">Loading attachments…</p>
        )}
        {attachments?.length === 0 && (
          <p className="muted">No attachments yet.</p>
        )}
        {attachments && attachments.length > 0 && (
          <ul className="attachment-list">
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <span>
                  {attachment.downloadUrl ? (
                    <a href={attachment.downloadUrl}>{attachment.filename}</a>
                  ) : (
                    <strong>{attachment.filename}</strong>
                  )}
                  <small>
                    {(attachment.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                    {attachment.scanState.toLowerCase()} ·{" "}
                    {attachment.uploader.displayName}
                  </small>
                </span>
                {attachment.canDelete && (
                  <button
                    className="text-button"
                    disabled={deletingAttachmentId === attachment.id}
                    onClick={() => void removeAttachment(attachment)}
                    type="button"
                  >
                    {deletingAttachmentId === attachment.id
                      ? "Removing…"
                      : "Remove"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAttach && (
          <form className="attachment-form" onSubmit={uploadAttachment}>
            <label htmlFor={`attachment-${issue.id}`}>Attach a file</label>
            <input
              id={`attachment-${issue.id}`}
              name="file"
              type="file"
              required
              accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv"
              aria-describedby={`attachment-help-${issue.id}`}
            />
            <small id={`attachment-help-${issue.id}`}>
              PDF, image, text, or CSV; maximum 10 MB. Files are malware scanned
              before download.
            </small>
            <button
              className="primary-button"
              disabled={uploading}
              type="submit"
            >
              {uploading ? "Scanning…" : "Upload file"}
            </button>
          </form>
        )}
      </section>
      <section className="comments" aria-labelledby="comments-heading">
        <div className="comments-heading">
          <h3 id="comments-heading">Comments</h3>
          <span className="count">{collaboration?.comments.length ?? 0}</span>
        </div>
        {!collaboration && !collaborationError && (
          <p className="muted">Loading comments…</p>
        )}
        {collaboration?.comments.length === 0 && (
          <p className="muted">No comments yet.</p>
        )}
        {collaboration && collaboration.comments.length > 0 && (
          <ol className="comment-list">
            {collaboration.comments.map((comment) => (
              <li key={comment.id}>
                <div>
                  <strong>{comment.author.displayName}</strong>
                  <time>{new Date(comment.createdAt).toLocaleString()}</time>
                </div>
                <p>{comment.body}</p>
              </li>
            ))}
          </ol>
        )}
        {canComment && (
          <form className="comment-form" onSubmit={submitComment}>
            <label htmlFor={`comment-${issue.id}`}>Add comment</label>
            <textarea
              id={`comment-${issue.id}`}
              value={commentBody}
              rows={4}
              maxLength={10_000}
              required
              onChange={(event) => setCommentBody(event.target.value)}
              aria-describedby={`comment-help-${issue.id}`}
            />
            <small id={`comment-help-${issue.id}`}>
              Mention an active project member with @email, for example
              @member@vibe.local.
            </small>
            <button
              className="primary-button"
              type="submit"
              disabled={commenting}
            >
              {commenting ? "Commenting…" : "Add comment"}
            </button>
          </form>
        )}
      </section>
      <h3>Activity</h3>
      <ol className="timeline">
        {[...issue.events].reverse().map((event) => (
          <li key={event.id}>
            <strong>{event.actorName}</strong>{" "}
            {event.eventType === "CREATED"
              ? "created this issue"
              : event.eventType === "TRANSITIONED"
                ? `moved it from ${statusName(event.payload.fromStatusId)} to ${statusName(event.payload.toStatusId)}`
                : event.eventType === "REORDERED"
                  ? "reordered this issue"
                  : event.eventType === "DELETED"
                    ? "deleted this issue"
                    : event.eventType === "RESTORED"
                      ? "restored this issue"
                      : event.eventType === "COMMENTED"
                        ? "commented on this issue"
                        : event.eventType === "ATTACHMENT_ADDED"
                          ? `attached ${String(event.payload.filename ?? "a file")}`
                          : event.eventType === "ATTACHMENT_REMOVED"
                            ? `removed ${String(event.payload.filename ?? "a file")}`
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
  board,
  onSave,
  onReload,
  onCancel,
}: {
  issue: IssueDetailView;
  board: BoardView;
  onSave: (input: {
    summary: string;
    description: string;
    priority: Priority;
    issueType: IssueType;
    assigneeId: string | null;
    labels: string[];
    parentIssueKey: string | null;
    estimatePoints: number | null;
    dueDate: string | null;
  }) => Promise<void>;
  onReload: () => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [issueType, setIssueType] = useState<IssueType>(issue.issueType);
  const [parentIssueKey, setParentIssueKey] = useState(issue.parent?.key ?? "");
  const [description, setDescription] = useState(issue.description);
  const parents = parentCandidates(board.issues, issueType, issue.id);

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
        issueType,
        assigneeId: assigneeId || null,
        labels: parseLabels(String(form.get("labels") ?? "")),
        parentIssueKey: parentIssueKey || null,
        estimatePoints: form.get("estimatePoints")
          ? Number(form.get("estimatePoints"))
          : null,
        dueDate: String(form.get("dueDate") ?? "") || null,
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
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={6}
          maxLength={20000}
        />
      </label>
      {description && (
        <section className="markdown-preview" aria-label="Description preview">
          <span className="eyebrow">Safe preview</span>
          <MarkdownText source={description} />
        </section>
      )}
      <label>
        Type
        <select
          name="issueType"
          value={issueType}
          onChange={(event) => {
            setIssueType(event.target.value as IssueType);
            setParentIssueKey("");
          }}
        >
          {issueTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
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
          {board.assignees.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Parent
        <select
          name="parentIssueKey"
          value={parentIssueKey}
          required={issueType === "SUBTASK"}
          disabled={issueType === "EPIC"}
          onChange={(event) => setParentIssueKey(event.target.value)}
        >
          <option value="">
            {issueType === "SUBTASK" ? "Select a parent" : "No parent"}
          </option>
          {parents.map((candidate) => (
            <option key={candidate.id} value={candidate.key}>
              {candidate.key} · {candidate.summary}
            </option>
          ))}
        </select>
      </label>
      <label>
        Labels
        <input
          name="labels"
          defaultValue={issue.labels.join(", ")}
          placeholder="frontend, customer request"
          aria-describedby="edit-labels-help"
        />
        <small id="edit-labels-help">
          Separate up to 20 labels with commas.
        </small>
      </label>
      <label>
        Estimate points
        <input
          defaultValue={issue.estimatePoints ?? ""}
          min={0}
          max={1000000}
          name="estimatePoints"
          type="number"
        />
      </label>
      <label>
        Due date
        <input defaultValue={issue.dueDate ?? ""} name="dueDate" type="date" />
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
  const fieldNames: Record<string, string> = {
    issueType: "type",
    assignee: "assignee",
    parent: "parent",
    labels: "labels",
    estimatePoints: "estimate",
    dueDate: "due date",
  };
  const fields = Array.isArray(payload.fields)
    ? payload.fields
        .filter((field): field is string => typeof field === "string")
        .map((field) => fieldNames[field] ?? field)
    : [];
  if (fields.length === 0) return "updated this issue";
  if (fields.length === 1) return `updated ${fields[0]}`;
  if (fields.length === 2) return `updated ${fields[0]} and ${fields[1]}`;
  return `updated ${fields.slice(0, -1).join(", ")}, and ${fields.at(-1)}`;
}
