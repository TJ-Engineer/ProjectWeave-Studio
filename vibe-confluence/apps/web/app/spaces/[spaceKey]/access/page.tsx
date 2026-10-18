import { spaceKeySchema } from "@knowledge/contracts";
import { listSpaceMembers } from "@knowledge/database";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SpaceAccessManager } from "@/components/space-access-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SpaceAccessPage({
  params,
}: {
  params: Promise<{ spaceKey: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { spaceKey: value } = await params;
  const parsed = spaceKeySchema.safeParse(value);
  if (!parsed.success) notFound();
  const input = { query: "", cursor: null, limit: 50 } as const;
  const [members, candidates] = await Promise.all([
    listSpaceMembers(identity, parsed.data, { ...input, kind: "members" }),
    listSpaceMembers(identity, parsed.data, {
      ...input,
      kind: "candidates",
    }),
  ]);
  return (
    <section className="page-shell">
      <div className="breadcrumbs">
        <Link href="/spaces">Spaces</Link>
        <span>/</span>
        <Link href={`/spaces/${members.space.key}`}>{members.space.name}</Link>
        <span>/</span>
        Access
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{members.space.key}</p>
          <h1>Space access</h1>
          <p className="muted">
            Manage direct members, role capabilities, and revocation safeguards.
          </p>
        </div>
      </div>
      <SpaceAccessManager
        currentUserId={identity.id}
        initialCandidates={candidates}
        initialMembers={members}
      />
    </section>
  );
}
