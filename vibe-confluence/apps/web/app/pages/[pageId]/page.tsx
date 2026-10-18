import type { PublishedPageView } from "@knowledge/contracts";
import { getPageWorkspace, getPublishedPage } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import Link from "next/link";
import { redirect } from "next/navigation";
import { KnowledgeEditor } from "@/components/knowledge-editor";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

function ArchivedPage({ view }: { view: PublishedPageView }) {
  return (
    <section className="page-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        <Link href={`/spaces/${view.space.key}`}>{view.space.name}</Link>
        <span>/</span>
        Archived
      </div>
      <article className="editor-card published-page" aria-readonly="true">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Archived · Read only</p>
            <h1>{view.revision.title}</h1>
          </div>
        </div>
        <div className="document-surface" aria-label="Published page content">
          {view.revision.document.content.map((block, index) => {
            const text = block.content.map((node) => node.text).join("");
            return block.type === "heading" ? (
              <h2 key={`${index}-${text}`}>{text}</h2>
            ) : (
              <p key={`${index}-${text}`}>{text}</p>
            );
          })}
        </div>
        <p className="muted">
          Revision {view.revision.number} · {view.revision.authorName} ·{" "}
          <time dateTime={view.revision.createdAt}>
            {new Date(view.revision.createdAt).toLocaleString()}
          </time>
        </p>
      </article>
    </section>
  );
}

export default async function PageEditor({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { pageId } = await params;
  let workspace;
  try {
    workspace = await getPageWorkspace(identity, pageId);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") {
      throw error;
    }
    const published = await getPublishedPage(identity, pageId);
    if (published.page.state !== "ARCHIVED") throw error;
    return <ArchivedPage view={published} />;
  }
  return (
    <section className="editor-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        <Link href={`/spaces/${workspace.space.key}`}>
          {workspace.space.name}
        </Link>
        <span>/</span>
        Draft
        {workspace.space.role === "ADMIN" ? (
          <>
            <span>/</span>
            <Link href={`/pages/${workspace.page.id}/access`}>Access</Link>
          </>
        ) : null}
      </div>
      <KnowledgeEditor initialWorkspace={workspace} />
    </section>
  );
}
