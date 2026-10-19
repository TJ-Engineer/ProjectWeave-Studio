import type { PublishedPageView } from "@knowledge/contracts";
import { getPageWorkspace, getPublishedPage } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import {
  openDocument,
  renderDocumentToHtml,
  renderFutureDocumentToHtml,
} from "@knowledge/editor";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

function PublishedPage({ view }: { view: PublishedPageView }) {
  const archived = view.page.state === "ARCHIVED";
  const openedDocument = openDocument(
    view.revision.futureDocument ?? view.revision.document,
  );
  const renderedDocument =
    openedDocument.mode === "editable"
      ? renderDocumentToHtml(openedDocument.document)
      : renderFutureDocumentToHtml(openedDocument.document);
  return (
    <section className="page-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/spaces/${view.space.key}`}>{view.space.name}</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{view.revision.title}</span>
      </nav>
      <article className="editor-card published-page" aria-readonly="true">
        <div className="published-page-heading">
          <div>
            <p className="eyebrow">
              {archived ? "Archived · Read only" : "Published · Read mode"}
            </p>
            <h1>{view.revision.title}</h1>
          </div>
          {view.canEdit ? (
            <Link
              className="primary-button"
              href={`/pages/${view.page.id}/edit`}
            >
              Edit page
            </Link>
          ) : null}
        </div>
        <div
          className="document-surface"
          aria-label="Published page content"
          dangerouslySetInnerHTML={{
            __html: renderedDocument,
          }}
        />
        <footer className="published-page-footer">
          Revision {view.revision.number} · {view.revision.authorName} ·{" "}
          <time dateTime={view.revision.createdAt}>
            {new Date(view.revision.createdAt).toLocaleString()}
          </time>
        </footer>
      </article>
    </section>
  );
}

export default async function PageRead({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { pageId } = await params;
  if (!z.uuid().safeParse(pageId).success) notFound();
  let view: PublishedPageView;
  try {
    view = await getPublishedPage(identity, pageId);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") {
      throw error;
    }
    try {
      await getPageWorkspace(identity, pageId);
    } catch (workspaceError) {
      if (
        workspaceError instanceof DomainError &&
        ["NOT_FOUND", "FORBIDDEN"].includes(workspaceError.code)
      ) {
        notFound();
      }
      throw workspaceError;
    }
    redirect(`/pages/${pageId}/edit`);
  }
  return <PublishedPage view={view} />;
}
