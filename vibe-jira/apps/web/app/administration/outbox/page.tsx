import { getOutboxHealth } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { OutboxMonitor } from "@/components/outbox-monitor";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OutboxAdministrationPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  if (identity.organizationRole !== "ADMIN") notFound();
  return (
    <OutboxMonitor
      displayName={identity.displayName}
      initialHealth={await getOutboxHealth(identity)}
    />
  );
}
