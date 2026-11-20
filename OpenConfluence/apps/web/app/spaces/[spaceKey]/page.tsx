import { listPageTree } from "@knowledge/database";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SpacePages } from "@/components/space-pages";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SpacePage({
  params,
}: {
  params: Promise<{ spaceKey: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { spaceKey } = await params;
  const tree = await listPageTree(identity, spaceKey, {
    parentId: null,
    cursor: null,
    limit: 50,
  });
  return (
    <section className="page-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        {tree.space.name}
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tree.space.key}</p>
          <h1>{tree.space.name}</h1>
          <p className="muted">
            {tree.space.description || "No description yet."}
          </p>
        </div>
        {tree.space.role === "ADMIN" ? (
          <Link
            className="secondary-button"
            href={`/spaces/${tree.space.key}/access`}
          >
            Manage access
          </Link>
        ) : null}
      </div>
      <SpacePages
        canAdminister={tree.space.role === "ADMIN"}
        canCreate={tree.space.role !== "VIEWER"}
        spaceKey={tree.space.key}
        initialTree={tree}
      />
    </section>
  );
}
