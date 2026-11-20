"use client";

import type {
  MovePageResult,
  PageSummary,
  PageTreeNode,
  PageTreePage,
} from "@knowledge/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

interface LoadedBranch {
  parentId: string | null;
  items: PageTreeNode[];
  nextCursor: string | null;
  version: number;
  loading: boolean;
  error: string;
}

interface VisibleTreeItem {
  node: PageTreeNode;
  parentId: string | null;
  level: number;
}

function branchKey(parentId: string | null): string {
  return parentId ?? "__ROOT__";
}

function branchFromTree(tree: PageTreePage): LoadedBranch {
  return {
    parentId: tree.parentId,
    items: tree.items,
    nextCursor: tree.nextCursor,
    version: tree.parentVersion,
    loading: false,
    error: "",
  };
}

export function SpacePages({
  canAdminister,
  canCreate,
  spaceKey,
  initialTree,
}: {
  canAdminister: boolean;
  canCreate: boolean;
  spaceKey: string;
  initialTree: PageTreePage;
}) {
  const router = useRouter();
  const [branches, setBranches] = useState<Record<string, LoadedBranch>>({
    [branchKey(null)]: branchFromTree(initialTree),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(
    initialTree.items[0]?.id ?? null,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingMoveId, setPendingMoveId] = useState<string | null>(null);
  const [movementStatus, setMovementStatus] = useState("");
  const treeItems = useRef(new Map<string, HTMLDivElement>());

  const visibleItems = useMemo(() => {
    const result: VisibleTreeItem[] = [];
    const visit = (parentId: string | null, level: number) => {
      for (const node of branches[branchKey(parentId)]?.items ?? []) {
        result.push({ node, parentId, level });
        if (expanded.has(node.id)) visit(node.id, level + 1);
      }
    };
    visit(null, 1);
    return result;
  }, [branches, expanded]);

  function focusTreeItem(pageId: string) {
    setFocusedId(pageId);
    window.requestAnimationFrame(() => treeItems.current.get(pageId)?.focus());
  }

  async function loadBranch(
    parentId: string | null,
    cursor: string | null,
    append: boolean,
  ): Promise<PageTreePage | null> {
    const key = branchKey(parentId);
    setBranches((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {
          parentId,
          items: [],
          nextCursor: null,
          version: 1,
        }),
        loading: true,
        error: "",
      },
    }));
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (parentId) query.set("parentId", parentId);
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(
        `/api/v1/spaces/${spaceKey}/tree?${query.toString()}`,
      );
      const body = (await response.json()) as PageTreePage & {
        error?: { message?: string };
      };
      if (!response.ok || !Array.isArray(body.items)) {
        const message = body.error?.message ?? "Page tree loading failed";
        setBranches((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? {
              parentId,
              items: [],
              nextCursor: null,
              version: 1,
            }),
            loading: false,
            error: message,
          },
        }));
        return null;
      }
      setBranches((current) => {
        const previous = current[key];
        return {
          ...current,
          [key]: {
            ...branchFromTree(body),
            items:
              append && previous
                ? [...previous.items, ...body.items]
                : body.items,
          },
        };
      });
      return body;
    } catch {
      const message = "The page tree is temporarily unavailable.";
      setBranches((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? {
            parentId,
            items: [],
            nextCursor: null,
            version: 1,
          }),
          loading: false,
          error: message,
        },
      }));
      return null;
    }
  }

  async function expandNode(node: PageTreeNode, focusFirstChild: boolean) {
    if (!node.hasChildren) return;
    let childItems = branches[branchKey(node.id)]?.items;
    if (!childItems) {
      childItems = (await loadBranch(node.id, null, false))?.items;
    }
    setExpanded((current) => new Set(current).add(node.id));
    if (focusFirstChild && childItems?.[0]) {
      focusTreeItem(childItems[0].id);
    }
  }

  function collapseNode(pageId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(pageId);
      return next;
    });
  }

  async function toggleNode(node: PageTreeNode) {
    if (expanded.has(node.id)) collapseNode(node.id);
    else await expandNode(node, false);
  }

  function handleTreeKey(
    event: KeyboardEvent<HTMLDivElement>,
    item: VisibleTreeItem,
  ) {
    const index = visibleItems.findIndex(
      (candidate) => candidate.node.id === item.node.id,
    );
    if (event.key === "ArrowDown" && visibleItems[index + 1]) {
      event.preventDefault();
      focusTreeItem(visibleItems[index + 1]!.node.id);
    } else if (event.key === "ArrowUp" && visibleItems[index - 1]) {
      event.preventDefault();
      focusTreeItem(visibleItems[index - 1]!.node.id);
    } else if (event.key === "ArrowRight" && item.node.hasChildren) {
      event.preventDefault();
      if (expanded.has(item.node.id)) {
        const firstChild = branches[branchKey(item.node.id)]?.items[0];
        if (firstChild) focusTreeItem(firstChild.id);
      } else {
        void expandNode(item.node, true);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expanded.has(item.node.id)) {
        collapseNode(item.node.id);
      } else if (item.parentId) {
        focusTreeItem(item.parentId);
      }
    } else if (event.key === "Home" && visibleItems[0]) {
      event.preventDefault();
      focusTreeItem(visibleItems[0].node.id);
    } else if (event.key === "End" && visibleItems.at(-1)) {
      event.preventDefault();
      focusTreeItem(visibleItems.at(-1)!.node.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      router.push(`/pages/${item.node.id}`);
    } else if (event.key === " " && item.node.hasChildren) {
      event.preventDefault();
      void toggleNode(item.node);
    }
  }

  async function moveRelative(
    parentId: string | null,
    index: number,
    direction: -1 | 1,
  ) {
    const key = branchKey(parentId);
    const branch = branches[key];
    if (!branch) return;
    const destination = index + direction;
    if (destination < 0 || destination >= branch.items.length) return;
    const moving = branch.items[index]!;
    const reordered = [...branch.items];
    reordered.splice(index, 1);
    reordered.splice(destination, 0, moving);
    const beforePageId = reordered[destination - 1]?.id ?? null;
    const afterPageId = reordered[destination + 1]?.id ?? null;
    setPendingMoveId(moving.id);
    setMovementStatus(`Moving ${moving.title}…`);
    setError("");
    try {
      const response = await fetch(`/api/v1/pages/${moving.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationParentId: parentId,
          beforePageId,
          afterPageId,
          expectedSourceVersion: branch.version,
          expectedDestinationVersion: branch.version,
        }),
      });
      const body = (await response.json()) as MovePageResult & {
        error?: { message?: string };
      };
      if (!response.ok || !body.page) {
        setError(body.error?.message ?? "Page movement failed");
        await loadBranch(parentId, null, false);
        return;
      }
      reordered[destination] = { ...moving, ...body.page };
      setBranches((current) => ({
        ...current,
        [key]: {
          ...current[key]!,
          items: reordered,
          version: body.destinationVersion,
          nextCursor: branch.nextCursor ? (reordered.at(-1)?.id ?? null) : null,
        },
      }));
      setMovementStatus(
        `${moving.title} moved ${direction < 0 ? "up" : "down"}.`,
      );
      focusTreeItem(moving.id);
    } catch {
      setError("The page could not be moved. Refresh and try again.");
      await loadBranch(parentId, null, false);
    } finally {
      setPendingMoveId(null);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const parentValue = data.get("parentId");
    try {
      const response = await fetch(`/api/v1/spaces/${spaceKey}/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: data.get("title"),
          parentId: parentValue || null,
        }),
      });
      const body = (await response.json()) as {
        page?: PageSummary;
        error?: { message?: string };
      };
      if (!response.ok || !body.page) {
        setError(body.error?.message ?? "Page creation failed");
        return;
      }
      form.reset();
      if (body.page.parentId) {
        setExpanded((current) => new Set(current).add(body.page!.parentId!));
        setBranches((current) => {
          const next: Record<string, LoadedBranch> = {};
          for (const [key, branch] of Object.entries(current)) {
            next[key] = {
              ...branch,
              items: branch.items.map((item) =>
                item.id === body.page!.parentId
                  ? { ...item, hasChildren: true }
                  : item,
              ),
            };
          }
          return next;
        });
      }
      await loadBranch(body.page.parentId, null, false);
      router.push(`/pages/${body.page.id}/edit`);
    } catch {
      setError("The page could not be created. Try again.");
    } finally {
      setPending(false);
    }
  }

  function renderBranch(
    parentId: string | null,
    level: number,
    parentTitle: string,
  ) {
    const branch = branches[branchKey(parentId)];
    if (!branch) return null;
    const listRole = parentId === null ? "tree" : "group";
    return (
      <ul
        aria-label={parentId === null ? "Pages" : undefined}
        className={parentId === null ? "page-tree" : "page-tree-group"}
        role={listRole}
      >
        {branch.items.map((node, index) => {
          const item: VisibleTreeItem = { node, parentId, level };
          const isExpanded = expanded.has(node.id);
          return (
            <li key={node.id} role="none">
              <div
                aria-expanded={node.hasChildren ? isExpanded : undefined}
                aria-label={`${node.title}, ${node.currentRevisionId ? "published" : "draft"}`}
                aria-level={level}
                className="page-tree-item"
                onFocus={() => setFocusedId(node.id)}
                onKeyDown={(event) => handleTreeKey(event, item)}
                ref={(element) => {
                  if (element) treeItems.current.set(node.id, element);
                  else treeItems.current.delete(node.id);
                }}
                role="treeitem"
                tabIndex={focusedId === node.id ? 0 : -1}
              >
                {node.hasChildren ? (
                  <button
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.title}`}
                    className="tree-toggle"
                    onClick={() => void toggleNode(node)}
                    onKeyDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                  </button>
                ) : (
                  <span aria-hidden="true" className="tree-leaf">
                    •
                  </span>
                )}
                <Link className="tree-page-link" href={`/pages/${node.id}`}>
                  {node.title}
                </Link>
                <span
                  className={
                    node.currentRevisionId ? "published-badge" : "draft-badge"
                  }
                >
                  {node.currentRevisionId ? "Published" : "Draft"}
                </span>
                <div className="tree-actions">
                  {canAdminister ? (
                    <>
                      <button
                        aria-label={`Move ${node.title} up`}
                        className="tree-move-button"
                        disabled={index === 0 || pendingMoveId !== null}
                        onClick={() => void moveRelative(parentId, index, -1)}
                        onKeyDown={(event) => event.stopPropagation()}
                        type="button"
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Move ${node.title} down`}
                        className="tree-move-button"
                        disabled={
                          index === branch.items.length - 1 ||
                          pendingMoveId !== null
                        }
                        onClick={() => void moveRelative(parentId, index, 1)}
                        onKeyDown={(event) => event.stopPropagation()}
                        type="button"
                      >
                        ↓
                      </button>
                      <Link
                        className="inline-action"
                        href={`/pages/${node.id}/access`}
                      >
                        Access
                      </Link>
                    </>
                  ) : null}
                </div>
              </div>
              {isExpanded ? renderBranch(node.id, level + 1, node.title) : null}
            </li>
          );
        })}
        {branch.nextCursor ? (
          <li className="tree-pagination" role="none">
            <button
              className="secondary-button"
              disabled={branch.loading}
              onClick={() => void loadBranch(parentId, branch.nextCursor, true)}
              type="button"
            >
              {branch.loading
                ? "Loading…"
                : `Load more ${parentId ? `under ${parentTitle}` : "pages"}`}
            </button>
          </li>
        ) : null}
        {branch.error ? (
          <li className="form-error" role="alert">
            {branch.error}
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <div className="split-grid">
      <section className="panel" aria-labelledby="page-tree-heading">
        <div className="section-heading">
          <div>
            <h2 id="page-tree-heading">Page tree</h2>
            <p className="muted tree-help" id="page-tree-help">
              Use Up and Down to move focus, Right to expand, Left to collapse,
              and Enter to open.
            </p>
          </div>
          <span className="tree-result-count">
            {visibleItems.length} loaded
          </span>
        </div>
        {branches[branchKey(null)]?.items.length ? (
          <div aria-describedby="page-tree-help">
            {renderBranch(null, 1, "the space")}
          </div>
        ) : (
          <p className="empty-state">This space has no pages yet.</p>
        )}
        <p className="visually-hidden" aria-live="polite">
          {movementStatus}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {canCreate ? (
        <section className="panel compact-panel">
          <h2>Create a page</h2>
          <form className="stack-form" onSubmit={create}>
            <label>
              Title
              <input name="title" maxLength={200} required />
            </label>
            <label>
              Parent page
              <select name="parentId" defaultValue="">
                <option value="">No parent</option>
                {visibleItems.map(({ node, level }) => (
                  <option key={node.id} value={node.id}>
                    {`${"— ".repeat(level - 1)}${node.title}`}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? "Creating…" : "Create page"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
