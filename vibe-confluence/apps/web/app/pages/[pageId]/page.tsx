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
