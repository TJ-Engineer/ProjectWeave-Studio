import { getPageWorkspace } from "@knowledge/database";
import Link from "next/link";
import { redirect } from "next/navigation";
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
  const workspace = await getPageWorkspace(identity, pageId);
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
