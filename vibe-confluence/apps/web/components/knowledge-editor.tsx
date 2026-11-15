"use client";

import type {
  DocumentNode,
  PageWorkspace,
  RevisionView,
} from "@knowledge/contracts";
import {
  openWithAdapter,
  renderDocumentToHtml,
  renderFutureDocumentToHtml,
} from "@knowledge/editor";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  richEditorAdapter,
  richEditorExtensions,
  type TiptapDocument,
} from "@/lib/rich-editor";

interface EditorSnapshot {
  title: string;
  document: DocumentNode;
}

interface SlashCommand {
  label: string;
  hint: string;
  run: (editor: Editor) => void;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function deleteSlash(editor: Editor) {
  const to = editor.state.selection.from;
  return editor
    .chain()
    .focus()
    .deleteRange({ from: Math.max(1, to - 1), to });
}

const slashCommands: SlashCommand[] = [
  {
    label: "Paragraph",
    hint: "Plain body text",
    run: (editor) => deleteSlash(editor).setParagraph().run(),
  },
  {
    label: "Heading 2",
    hint: "Section heading",
    run: (editor) => deleteSlash(editor).setHeading({ level: 2 }).run(),
  },
  {
    label: "Bulleted list",
    hint: "Unordered items",
    run: (editor) => deleteSlash(editor).toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    hint: "Ordered items",
    run: (editor) => deleteSlash(editor).toggleOrderedList().run(),
  },
  {
    label: "Task list",
    hint: "Checkable items",
    run: (editor) => deleteSlash(editor).toggleTaskList().run(),
  },
  {
    label: "Quote",
    hint: "Block quotation",
    run: (editor) => deleteSlash(editor).toggleBlockquote().run(),
  },
  {
    label: "Divider",
    hint: "Section break",
    run: (editor) => deleteSlash(editor).setHorizontalRule().run(),
  },
  {
    label: "Callout",
    hint: "Highlighted information",
    run: (editor) =>
      deleteSlash(editor)
        .insertContent({
          type: "callout",
          attrs: { tone: "info", title: "Note" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    label: "Table",
    hint: "Header plus two rows",
    run: (editor) =>
      deleteSlash(editor)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    label: "Code block",
    hint: "Fenced code",
    run: (editor) => deleteSlash(editor).toggleCodeBlock().run(),
  },
  {
    label: "Expand",
    hint: "Collapsible details",
    run: (editor) =>
      deleteSlash(editor)
        .insertContent({
          type: "expand",
          attrs: { summary: "Details" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    label: "Table of contents",
    hint: "Generated from headings",
    run: (editor) =>
      deleteSlash(editor)
        .insertContent({
          type: "tableOfContents",
          attrs: { minLevel: 2, maxLevel: 6 },
        })
        .run(),
  },
];

function ToolbarButton({
  active = false,
  disabled = false,
  label,
  onClick,
}: {
  active?: boolean | undefined;
  disabled?: boolean;
  label: string;
  onClick: () => unknown;
}) {
  return (
    <button
      aria-pressed={active}
      className="editor-tool"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

export function KnowledgeEditor({
  initialWorkspace,
}: {
  initialWorkspace: PageWorkspace;
}) {
  const [initialEditorState] = useState(() => {
    const source =
      initialWorkspace.draft.futureDocument ?? initialWorkspace.draft.document;
    const opened = openWithAdapter(source, richEditorAdapter);
    return {
      opened,
      document:
        opened.mode === "editable"
          ? richEditorAdapter.toCanonical(opened.engineDocument)
          : initialWorkspace.draft.document,
      engineDocument:
        opened.mode === "editable"
          ? opened.engineDocument
          : ({
              type: "doc",
              content: [{ type: "paragraph" }],
            } satisfies TiptapDocument),
      readOnly: opened.mode !== "editable",
    };
  });
  const initialOpened = initialEditorState.opened;
  const initialDocument = initialEditorState.document;
  const initialEngineDocument = initialEditorState.engineDocument;
  const adapterReadOnly = initialEditorState.readOnly;

  const [title, setTitle] = useState(initialWorkspace.draft.title);
  const [document, setDocument] = useState(initialDocument);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const [conversionError, setConversionError] = useState("");
  const [isEditorValid, setIsEditorValid] = useState(true);
  const [pasteWarnings, setPasteWarnings] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [insertKind, setInsertKind] = useState("date");
  const [revisions, setRevisions] = useState(initialWorkspace.revisions);
  const [diff, setDiff] = useState<{ kind: string; text: string }[]>([]);
  const versionRef = useRef(initialWorkspace.draft.version);
  const baseRef = useRef(initialWorkspace.draft.baseRevisionId);
  const latestRef = useRef<EditorSnapshot>({ title, document });
  const dirtyGeneration = useRef(0);
  const savedGeneration = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(false);
  const suppressAutosave = useRef(false);
  const editorValid = useRef(true);
  const editorInstance = useRef<Editor | null>(null);
  const slashMenuOpenRef = useRef(false);
  const slashIndexRef = useRef(0);

  const handlePasteWarning = useCallback(
    (warnings: readonly string[]) => {
      setPasteWarnings([...warnings]);
    },
    [setPasteWarnings],
  );
  const extensions = useMemo(
    () => richEditorExtensions(handlePasteWarning),
    [handlePasteWarning],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !adapterReadOnly,
    extensions,
    content: initialEngineDocument,
    editorProps: {
      attributes: {
        class: "rich-editor-content",
        role: "textbox",
        "aria-label": "Page content editor",
        "aria-multiline": "true",
      },
      handleKeyDown(_view, event) {
        if (!slashMenuOpenRef.current) return false;
        if (event.key === "Escape") {
          slashMenuOpenRef.current = false;
          setSlashMenuOpen(false);
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const offset = event.key === "ArrowDown" ? 1 : -1;
          slashIndexRef.current =
            (slashIndexRef.current + offset + slashCommands.length) %
            slashCommands.length;
          setSlashIndex(slashIndexRef.current);
          return true;
        }
        if (event.key === "Enter") {
          const currentEditor = editorInstance.current;
          if (currentEditor)
            slashCommands[slashIndexRef.current]!.run(currentEditor);
          slashMenuOpenRef.current = false;
          setSlashMenuOpen(false);
          return true;
        }
        return false;
      },
    },
    onCreate({ editor: createdEditor }) {
      editorInstance.current = createdEditor;
    },
    onDestroy() {
      editorInstance.current = null;
    },
    onUpdate({ editor: updatedEditor }) {
      try {
        const nextDocument = richEditorAdapter.toCanonical(
          updatedEditor.getJSON(),
        );
        editorValid.current = true;
        setIsEditorValid(true);
        setConversionError("");
        setDocument(nextDocument);
        const { $from } = updatedEditor.state.selection;
        const opensMenu =
          $from.parent.type.name === "paragraph" &&
          $from.parent.textContent === "/";
        slashMenuOpenRef.current = opensMenu;
        setSlashMenuOpen(opensMenu);
        if (opensMenu) {
          slashIndexRef.current = 0;
          setSlashIndex(0);
        }
      } catch (caught) {
        editorValid.current = false;
        setIsEditorValid(false);
        setStatus("Invalid content");
        setConversionError(
          caught instanceof Error
            ? caught.message
            : "The document cannot be saved safely.",
        );
      }
    },
  });

  const clearAfterRevocation = useCallback(() => {
    suppressAutosave.current = true;
    latestRef.current = { title: "", document: latestRef.current.document };
    dirtyGeneration.current = 0;
    savedGeneration.current = 0;
    setTitle("");
    setDiff([]);
    setRevisions([]);
    window.location.replace("/spaces");
  }, [setDiff, setRevisions, setTitle]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!editorValid.current) {
      setStatus("Invalid content");
      return false;
    }
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
                document: snapshot.document,
                baseRevisionId: baseRef.current,
                version: versionRef.current,
              }),
            },
          );
          const body = (await response.json()) as {
            draft?: { version: number };
            error?: { message?: string };
          };
          if (response.status === 403 || response.status === 404) {
            clearAfterRevocation();
            return false;
          }
          if (!response.ok || !body.draft) {
            setStatus("Save failed");
            setError(body.error?.message ?? "Draft save failed");
            return false;
          }
          versionRef.current = body.draft.version;
          savedGeneration.current = generation;
          if (savedGeneration.current === dirtyGeneration.current) {
            setStatus("Saved");
          }
          return true;
        } catch {
          setStatus("Offline");
          setError(
            "The draft could not reach the server. Your content remains in this tab.",
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
  }, [clearAfterRevocation, initialWorkspace.page.id]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (suppressAutosave.current) {
      suppressAutosave.current = false;
      return;
    }
    latestRef.current = { title, document };
    dirtyGeneration.current += 1;
    setStatus("Unsaved");
    const timer = window.setTimeout(() => void flushSave(), 700);
    return () => window.clearTimeout(timer);
  }, [title, document, flushSave]);

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
          document: snapshot.document,
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
    if (response.status === 403 || response.status === 404) {
      clearAfterRevocation();
      return;
    }
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
    if (response.status === 403 || response.status === 404) {
      clearAfterRevocation();
      return;
    }
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
    if (response.status === 403 || response.status === 404) {
      clearAfterRevocation();
      return;
    }
    if (!response.ok || !body.revision) {
      setError(body.error?.message ?? "Restore failed");
      return;
    }
    const opened = openWithAdapter(
      body.revision.futureDocument ?? body.revision.document,
      richEditorAdapter,
    );
    if (opened.mode !== "editable" || !editor) {
      setError(
        "This revision uses content that the current editor cannot change safely.",
      );
      return;
    }
    const restoredDocument = richEditorAdapter.toCanonical(
      opened.engineDocument,
    );
    baseRef.current = body.revision.id;
    versionRef.current += 1;
    latestRef.current = {
      title: body.revision.title,
      document: restoredDocument,
    };
    dirtyGeneration.current += 1;
    savedGeneration.current = dirtyGeneration.current;
    suppressAutosave.current = true;
    editorValid.current = true;
    setIsEditorValid(true);
    editor.commands.setContent(opened.engineDocument, { emitUpdate: false });
    setTitle(body.revision.title);
    setDocument(restoredDocument);
    setConversionError("");
    setRevisions((current) => [body.revision!, ...current]);
    setStatus(`Restored as revision ${body.revision.number}`);
  }

  function setExternalLink() {
    if (!editor) return;
    const current = editor.getAttributes("link").href;
    const href = window.prompt(
      "Absolute HTTP, HTTPS, or mailto URL",
      current ?? "",
    );
    if (href === null) return;
    if (!href.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    try {
      const parsed = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol))
        throw new Error();
      if (href.length > 2_048) throw new Error();
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: parsed.toString() })
        .run();
    } catch {
      setError("Links must use an absolute HTTP, HTTPS, or mailto URL.");
    }
  }

  function insertReference() {
    if (!editor) return;
    if (insertKind === "date") {
      const value = window.prompt(
        "Date in YYYY-MM-DD format",
        new Date().toISOString().slice(0, 10),
      );
      if (value && !isValidCalendarDate(value)) {
        setError("Use a valid date in YYYY-MM-DD format.");
        return;
      }
      if (value)
        editor
          .chain()
          .focus()
          .insertContent({ type: "date", attrs: { value } })
          .run();
      return;
    }
    if (insertKind === "status") {
      const text = window.prompt("Status text", "In progress");
      if (text && text.length > 200) {
        setError("Status text must contain no more than 200 characters.");
        return;
      }
      if (text)
        editor
          .chain()
          .focus()
          .insertContent({ type: "status", attrs: { text, tone: "info" } })
          .run();
      return;
    }
    if (insertKind === "labelReference") {
      const label = window.prompt("Label", "release-1");
      if (label && label.length > 200) {
        setError("A label must contain no more than 200 characters.");
        return;
      }
      if (label)
        editor
          .chain()
          .focus()
          .insertContent({ type: "labelReference", attrs: { label } })
          .run();
      return;
    }
    const pageId = window.prompt("Destination page UUID");
    if (!pageId) return;
    if (!uuidPattern.test(pageId)) {
      setError("A page link requires a valid page UUID.");
      return;
    }
    const label = window.prompt("Page link label", "Linked page");
    if (label && label.length > 200) {
      setError("A page-link label must contain no more than 200 characters.");
      return;
    }
    if (label)
      editor
        .chain()
        .focus()
        .insertContent({ type: "pageLink", attrs: { pageId, label } })
        .run();
  }

  function editCallout() {
    if (!editor) return;
    const current = editor.getAttributes("callout");
    const title = window.prompt("Callout title", current.title ?? "Note");
    if (title === null) return;
    const tone = window.prompt(
      "Callout tone: info, note, success, warning, or danger",
      current.tone ?? "info",
    );
    if (tone === null) return;
    if (!["info", "note", "success", "warning", "danger"].includes(tone)) {
      setError("Choose a supported callout tone.");
      return;
    }
    if (title.length > 2_000) {
      setError("A callout title must contain no more than 2,000 characters.");
      return;
    }
    editor
      .chain()
      .focus()
      .updateAttributes("callout", { title: title || null, tone })
      .run();
  }

  function editExpandSummary() {
    if (!editor) return;
    const summary = window.prompt(
      "Expand summary",
      editor.getAttributes("expand").summary ?? "Details",
    );
    if (summary === null) return;
    if (!summary || summary.length > 200) {
      setError("An expand summary must contain between 1 and 200 characters.");
      return;
    }
    editor.chain().focus().updateAttributes("expand", { summary }).run();
  }

  function editCodeLanguage() {
    if (!editor) return;
    const language = window.prompt(
      "Code language (optional)",
      editor.getAttributes("codeBlock").language ?? "",
    );
    if (language === null) return;
    if (language.length > 100) {
      setError("A code language must contain no more than 100 characters.");
      return;
    }
    editor
      .chain()
      .focus()
      .updateAttributes("codeBlock", { language: language || null })
      .run();
  }

  function runSlashCommand(command: SlashCommand) {
    if (!editor) return;
    command.run(editor);
    slashMenuOpenRef.current = false;
    setSlashMenuOpen(false);
  }

  function retainSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
  }

  const readOnlyHtml =
    initialOpened.mode === "readOnlyFuture"
      ? renderFutureDocumentToHtml(initialOpened.document)
      : initialOpened.mode === "readOnlyCanonical"
        ? renderDocumentToHtml(initialOpened.document)
        : "";

  if (adapterReadOnly) {
    return (
      <article className="editor-card">
        <p className="eyebrow">Read only</p>
        <h1>{initialWorkspace.draft.title}</h1>
        <p role="status">
          This document uses canonical content that the current editor cannot
          change without loss. Its source remains preserved.
        </p>
        <div
          className="document-surface"
          aria-label="Read-only page content"
          dangerouslySetInnerHTML={{ __html: readOnlyHtml }}
        />
      </article>
    );
  }

  const previewHtml = previewing ? renderDocumentToHtml(document) : "";

  return (
    <div className="editor-grid">
      <article className="editor-card">
        <div className="editor-toolbar editor-toolbar-primary">
          <span className="save-state" aria-live="polite">
            {status}
          </span>
          <div className="button-row">
            <button
              aria-pressed={previewing}
              className="secondary-button"
              onClick={() => setPreviewing((current) => !current)}
              type="button"
            >
              {previewing ? "Edit" : "Preview"}
            </button>
            <button
              className="primary-button"
              disabled={!editor || !isEditorValid}
              onClick={publish}
              type="button"
            >
              Publish
            </button>
          </div>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {conversionError ? (
          <p className="form-error" role="alert">
            {conversionError}
          </p>
        ) : null}
        {pasteWarnings.length ? (
          <div className="paste-warning" role="status">
            <strong>Paste adjusted</strong>
            <ul>
              {pasteWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <button onClick={() => setPasteWarnings([])} type="button">
              Dismiss
            </button>
          </div>
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

        {previewing ? (
          <div
            className="document-surface rich-preview"
            aria-label="Page preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <>
            <div
              className="rich-editor-toolbar"
              role="toolbar"
              aria-label="Text formatting"
            >
              <ToolbarButton
                active={editor?.isActive("bold")}
                disabled={!editor}
                label="Bold"
                onClick={() => editor?.chain().focus().toggleBold().run()}
              />
              <ToolbarButton
                active={editor?.isActive("italic")}
                disabled={!editor}
                label="Italic"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
              />
              <ToolbarButton
                active={editor?.isActive("underline")}
                disabled={!editor}
                label="Underline"
                onClick={() => editor?.chain().focus().toggleUnderline().run()}
              />
              <ToolbarButton
                active={editor?.isActive("strike")}
                disabled={!editor}
                label="Strike"
                onClick={() => editor?.chain().focus().toggleStrike().run()}
              />
              <ToolbarButton
                active={editor?.isActive("code")}
                disabled={!editor}
                label="Inline code"
                onClick={() => editor?.chain().focus().toggleCode().run()}
              />
              <ToolbarButton
                active={editor?.isActive("link")}
                disabled={!editor}
                label="Link"
                onClick={setExternalLink}
              />
              <ToolbarButton
                active={editor?.isActive("heading", { level: 2 })}
                disabled={!editor}
                label="Heading"
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 2 }).run()
                }
              />
              <ToolbarButton
                active={editor?.isActive("bulletList")}
                disabled={!editor}
                label="Bullets"
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
              />
              <ToolbarButton
                active={editor?.isActive("orderedList")}
                disabled={!editor}
                label="Numbering"
                onClick={() =>
                  editor?.chain().focus().toggleOrderedList().run()
                }
              />
              <ToolbarButton
                active={editor?.isActive("taskList")}
                disabled={!editor}
                label="Tasks"
                onClick={() => editor?.chain().focus().toggleTaskList().run()}
              />
              <ToolbarButton
                active={editor?.isActive("blockquote")}
                disabled={!editor}
                label="Quote"
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              />
            </div>

            <div className="insert-row">
              <label htmlFor="insert-reference">Insert safe reference</label>
              <select
                id="insert-reference"
                value={insertKind}
                onChange={(event) => setInsertKind(event.target.value)}
              >
                <option value="date">Date</option>
                <option value="status">Status</option>
                <option value="labelReference">Label</option>
                <option value="pageLink">Page link</option>
              </select>
              <button
                className="secondary-button"
                onClick={insertReference}
                type="button"
              >
                Insert
              </button>
            </div>

            {editor?.isActive("table") ? (
              <div
                className="rich-editor-toolbar"
                role="toolbar"
                aria-label="Table tools"
              >
                <ToolbarButton
                  label="Previous cell"
                  onClick={() =>
                    editor.chain().focus().goToPreviousCell().run()
                  }
                />
                <ToolbarButton
                  label="Next cell"
                  onClick={() => editor.chain().focus().goToNextCell().run()}
                />
                <ToolbarButton
                  label="Add row"
                  onClick={() => editor.chain().focus().addRowAfter().run()}
                />
                <ToolbarButton
                  label="Add column"
                  onClick={() => editor.chain().focus().addColumnAfter().run()}
                />
                <ToolbarButton
                  label="Delete row"
                  onClick={() => editor.chain().focus().deleteRow().run()}
                />
                <ToolbarButton
                  label="Delete column"
                  onClick={() => editor.chain().focus().deleteColumn().run()}
                />
              </div>
            ) : null}

            {editor?.isActive("callout") ||
            editor?.isActive("expand") ||
            editor?.isActive("codeBlock") ? (
              <div
                className="rich-editor-toolbar"
                role="toolbar"
                aria-label="Block attributes"
              >
                {editor.isActive("callout") ? (
                  <ToolbarButton label="Edit callout" onClick={editCallout} />
                ) : null}
                {editor.isActive("expand") ? (
                  <ToolbarButton
                    label="Edit expand summary"
                    onClick={editExpandSummary}
                  />
                ) : null}
                {editor.isActive("codeBlock") ? (
                  <ToolbarButton
                    label="Set code language"
                    onClick={editCodeLanguage}
                  />
                ) : null}
              </div>
            ) : null}

            <div className="document-surface rich-editor-surface">
              <EditorContent editor={editor} />
              {slashMenuOpen ? (
                <>
                  <p className="visually-hidden" role="status">
                    Insert block menu. {slashCommands[slashIndex]!.label}{" "}
                    selected. Use the up and down arrows, Enter to insert, or
                    Escape to close.
                  </p>
                  <div
                    className="slash-menu"
                    aria-label="Insert block"
                    role="listbox"
                  >
                    {slashCommands.map((command, index) => (
                      <button
                        aria-selected={slashIndex === index}
                        key={command.label}
                        onMouseDown={retainSelection}
                        onClick={() => runSlashCommand(command)}
                        role="option"
                        type="button"
                      >
                        <strong>{command.label}</strong>
                        <span>{command.hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <p className="editor-help">
              Type <kbd>/</kbd> on an empty line for blocks. Markdown shortcuts
              such as
              <kbd>##</kbd>, <kbd>-</kbd>, <kbd>1.</kbd>, <kbd>&gt;</kbd>, and
              <kbd>```</kbd> are supported. Use Tab and Shift+Tab between table
              cells.
            </p>
          </>
        )}
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
