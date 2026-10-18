import { listPages } from "@knowledge/database";
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
  const result = await listPages(identity, spaceKey);
  return (
    <section className="page-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        {result.space.name}
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{result.space.key}</p>
          <h1>{result.space.name}</h1>
          <p className="muted">
            {result.space.description || "No description yet."}
          </p>
        </div>
        {result.space.role === "ADMIN" ? (
          <Link
            className="secondary-button"
            href={`/spaces/${result.space.key}/access`}
          >
            Manage access
          </Link>
        ) : null}
      </div>
      <SpacePages
        canAdminister={result.space.role === "ADMIN"}
        spaceKey={result.space.key}
        initialPages={result.pages}
      />
    </section>
  );
}
