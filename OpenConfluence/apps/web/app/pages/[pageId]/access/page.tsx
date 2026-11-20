import {
  getPageRestrictionAdministration,
  listSpaceMembers,
} from "@knowledge/database";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { PageRestrictionManager } from "@/components/page-restriction-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PageAccessPage({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { pageId } = await params;
  if (!z.uuid().safeParse(pageId).success) notFound();
  const restriction = await getPageRestrictionAdministration(identity, pageId);
  const members = await listSpaceMembers(identity, restriction.space.key, {
    kind: "members",
    query: "",
    cursor: null,
    limit: 50,
  });
  return (
    <section className="page-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        <Link href={`/spaces/${restriction.space.key}`}>
          {restriction.space.name}
        </Link>
        <span>/</span>
        Page access
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Page policy</p>
          <h1>{restriction.page.title}</h1>
          <p className="muted">
            Administrators always retain access to published content.
          </p>
        </div>
      </div>
      <PageRestrictionManager
        initialMembers={members}
        initialRestriction={restriction}
      />
    </section>
  );
}
