import { listSpaces } from "@knowledge/database";
import { redirect } from "next/navigation";
import { SpacesManager } from "@/components/spaces-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  return (
    <section className="page-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Knowledge workspace</p>
          <h1>Spaces</h1>
          <p className="muted">
            Organize durable, revisioned knowledge for your team.
          </p>
        </div>
      </div>
      <SpacesManager initialSpaces={await listSpaces(identity)} />
    </section>
  );
}
