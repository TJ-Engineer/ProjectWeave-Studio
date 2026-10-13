import { getAuditEvents } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { AuditLog } from "@/components/audit-log";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AuditAdministrationPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  if (identity.organizationRole !== "ADMIN") notFound();
  return (
    <AuditLog
      displayName={identity.displayName}
      initialView={await getAuditEvents(identity, { limit: 50 })}
    />
  );
}
