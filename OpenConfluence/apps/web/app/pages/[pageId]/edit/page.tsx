import type { PageWorkspace } from "@knowledge/contracts";
import { getPageWorkspace } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { KnowledgeEditor } from "@/components/knowledge-editor";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PageEditor({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { pageId } = await params;
  if (!z.uuid().safeParse(pageId).success) notFound();
  let workspace: PageWorkspace;
  try {
    workspace = await getPageWorkspace(identity, pageId);
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["NOT_FOUND", "FORBIDDEN"].includes(error.code)
    ) {
      notFound();
    }
    throw error;
  }
  return (
    <section className="editor-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/spaces/${workspace.space.key}`}>
          {workspace.space.name}
        </Link>
        {workspace.page.currentRevisionId ? (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/pages/${workspace.page.id}`}>Read</Link>
          </>
        ) : null}
        <span aria-hidden="true">/</span>
        <span aria-current="page">Edit</span>
        {workspace.space.role === "ADMIN" ? (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/pages/${workspace.page.id}/access`}>Access</Link>
          </>
        ) : null}
      </nav>
      <KnowledgeEditor initialWorkspace={workspace} />
    </section>
  );
}
