import { getKanbanReports, getProjectAccess } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { ReportsDashboard } from "@/components/reports-dashboard";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { projectKey } = await params;
  const access = await getProjectAccess(identity.id, projectKey.toUpperCase());
  if (!access) notFound();
  return (
    <ReportsDashboard
      displayName={identity.displayName}
      initialView={await getKanbanReports(identity, access, {})}
    />
  );
}
