"use client";

import type {
  DocumentNode,
  PageWorkspace,
  RevisionView,
} from "@knowledge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

function textFor(
  document: DocumentNode,
  type: "heading" | "paragraph",
): string {
  const block = document.content.find((candidate) => candidate.type === type);
  return block?.content.map((node) => node.text).join("") ?? "";
}

function makeDocument(heading: string, paragraph: string): DocumentNode {
  return {
    type: "doc",
    schemaVersion: 1,
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: heading ? [{ type: "text", text: heading }] : [],
      },
      {
        type: "paragraph",
        content: paragraph ? [{ type: "text", text: paragraph }] : [],
      },
    ],
  };
}

interface EditorSnapshot {
  title: string;
  heading: string;
  paragraph: string;
}

export function KnowledgeEditor({
  initialWorkspace,
}: {
  initialWorkspace: PageWorkspace;
}) {
  const [title, setTitle] = useState(initialWorkspace.draft.title);
  const [heading, setHeading] = useState(
    textFor(initialWorkspace.draft.document, "heading"),
  );
  const [paragraph, setParagraph] = useState(
    textFor(initialWorkspace.draft.document, "paragraph"),
  );
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const [revisions, setRevisions] = useState(initialWorkspace.revisions);
  const [diff, setDiff] = useState<{ kind: string; text: string }[]>([]);
  const versionRef = useRef(initialWorkspace.draft.version);
  const baseRef = useRef(initialWorkspace.draft.baseRevisionId);
  const latestRef = useRef<EditorSnapshot>({ title, heading, paragraph });
  const dirtyGeneration = useRef(0);
  const savedGeneration = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(false);
  const suppressAutosave = useRef(false);

  const flushSave = useCallback(async (): Promise<boolean> => {
    while (savedGeneration.current < dirtyGeneration.current) {
      if (savePromise.current) {
        const succeeded = await savePromise.current;
        if (!succeeded) return false;
        continue;
      }
      const generation = dirtyGeneration.current;
      const snapshot = latestRef.current;
      setStatus("Saving…");
      setError("");
      const request = (async () => {
        try {
          const response = await fetch(
            `/api/v1/pages/${initialWorkspace.page.id}/draft`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: snapshot.title,
                document: makeDocument(snapshot.heading, snapshot.paragraph),
                baseRevisionId: baseRef.current,
                version: versionRef.current,
              }),
            },
          );
          const body = (await response.json()) as {
            draft?: { version: number };
            error?: { message?: string };
          };
          if (!response.ok || !body.draft) {
            setStatus("Save failed");
            setError(body.error?.message ?? "Draft save failed");
            return false;
          }
          versionRef.current = body.draft.version;
          savedGeneration.current = generation;
          if (savedGeneration.current === dirtyGeneration.current)
            setStatus("Saved");
          return true;
        } catch {
          setStatus("Offline");
          setError(
            "The draft could not reach the server. Your text remains in this tab.",
          );
          return false;
        }
      })();
      savePromise.current = request;
      const succeeded = await request;
      if (savePromise.current === request) savePromise.current = null;
      if (!succeeded) return false;
    }
    return true;
  }, [initialWorkspace.page.id]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (suppressAutosave.current) {
      suppressAutosave.current = false;
      return;
    }
    latestRef.current = { title, heading, paragraph };
    dirtyGeneration.current += 1;
    setStatus("Unsaved");
    const timer = window.setTimeout(() => void flushSave(), 700);
    return () => window.clearTimeout(timer);
  }, [title, heading, paragraph, flushSave]);

  async function publish() {
    if (!(await flushSave())) return;
    setStatus("Publishing…");
    setError("");
    const snapshot = latestRef.current;
    const response = await fetch(
      `/api/v1/pages/${initialWorkspace.page.id}/publish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          title: snapshot.title,
          document: makeDocument(snapshot.heading, snapshot.paragraph),
          baseRevisionId: baseRef.current,
          version: versionRef.current,
          summary: revisions.length ? "Updated page" : "Initial publication",
        }),
      },
    );
    const body = (await response.json()) as {
      revision?: RevisionView;
      error?: { message?: string };
    };
    if (!response.ok || !body.revision) {
      setStatus("Publish failed");
      setError(body.error?.message ?? "Publication failed");
      return;
    }
    baseRef.current = body.revision.id;
    versionRef.current += 1;
    setRevisions((current) => [body.revision!, ...current]);
    setStatus(`Published revision ${body.revision.number}`);
  }

  async function compare(number: number) {
    const response = await fetch(
      `/api/v1/pages/${initialWorkspace.page.id}/revisions/${number}/diff`,
    );
    const body = (await response.json()) as {
      lines?: { kind: string; text: string }[];
      error?: { message?: string };
    };
    if (!response.ok || !body.lines) {
      setError(body.error?.message ?? "Comparison failed");
      return;
    }
    setDiff(body.lines);
  }

  async function restore(revision: RevisionView) {
    setError("");
    const response = await fetch(
      `/api/v1/pages/${initialWorkspace.page.id}/revisions/${revision.number}/restore`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          expectedHeadRevisionId: baseRef.current,
          summary: `Restored revision ${revision.number}`,
        }),
      },
    );
    const body = (await response.json()) as {
      revision?: RevisionView;
      error?: { message?: string };
    };
    if (!response.ok || !body.revision) {
      setError(body.error?.message ?? "Restore failed");
      return;
    }
    const nextTitle = body.revision.title;
    const nextHeading = textFor(body.revision.document, "heading");
    const nextParagraph = textFor(body.revision.document, "paragraph");
    baseRef.current = body.revision.id;
    versionRef.current += 1;
    latestRef.current = {
      title: nextTitle,
      heading: nextHeading,
      paragraph: nextParagraph,
    };
    dirtyGeneration.current += 1;
    savedGeneration.current = dirtyGeneration.current;
    suppressAutosave.current = true;
    setTitle(nextTitle);
    setHeading(nextHeading);
    setParagraph(nextParagraph);
    setRevisions((current) => [body.revision!, ...current]);
    setStatus(`Restored as revision ${body.revision.number}`);
  }

  return (
    <div className="editor-grid">
      <article className="editor-card">
        <div className="editor-toolbar">
          <span className="save-state" aria-live="polite">
            {status}
          </span>
          <button className="primary-button" onClick={publish} type="button">
            Publish
          </button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="visually-hidden" htmlFor="page-title">
          Page title
        </label>
        <input
          id="page-title"
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
        />
        <div className="document-surface" aria-label="Page content editor">
          <label className="visually-hidden" htmlFor="page-heading">
            Heading
          </label>
          <input
            id="page-heading"
            className="heading-input"
            value={heading}
            onChange={(event) => setHeading(event.target.value)}
            placeholder="Heading"
            maxLength={5000}
          />
          <label className="visually-hidden" htmlFor="page-paragraph">
            Paragraph
          </label>
          <textarea
            id="page-paragraph"
            className="paragraph-input"
            value={paragraph}
            onChange={(event) => setParagraph(event.target.value)}
            placeholder="Start writing…"
            rows={14}
            maxLength={20000}
          />
        </div>
      </article>
      <aside className="history-panel" aria-labelledby="history-heading">
        <h2 id="history-heading">Revision history</h2>
        {revisions.length ? (
          revisions.map((revision) => (
            <article className="revision-card" key={revision.id}>
              <strong>Revision {revision.number}</strong>
              <span>{revision.authorName}</span>
              <time dateTime={revision.createdAt}>
                {new Date(revision.createdAt).toLocaleString()}
              </time>
              <p>{revision.summary || "No change summary"}</p>
              <div className="button-row">
                <button onClick={() => compare(revision.number)} type="button">
                  Compare
                </button>
                <button onClick={() => restore(revision)} type="button">
                  Restore
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="empty-state">Publish to create revision 1.</p>
        )}
        {diff.length ? (
          <div className="diff" aria-label="Revision comparison">
            <h3>Comparison</h3>
            {diff.map((line, index) => (
              <div
                className={`diff-${line.kind}`}
                key={`${index}-${line.text}`}
              >
                {line.kind === "added"
                  ? "+ "
                  : line.kind === "removed"
                    ? "− "
                    : "  "}
                {line.text || "(blank)"}
              </div>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
