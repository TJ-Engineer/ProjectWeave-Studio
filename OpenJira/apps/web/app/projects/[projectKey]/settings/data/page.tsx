import { getDataJobs, getProjectAccess } from "@vibe/database";
import { can } from "@vibe/domain";
import { notFound, redirect } from "next/navigation";
import { DataJobsManager } from "@/components/data-jobs-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DataSettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { projectKey } = await params;
  const access = await getProjectAccess(identity.id, projectKey.toUpperCase());
  if (
    !access ||
    !can(access.organizationRole, access.projectRole, "data:manage")
  ) {
    notFound();
  }
  return (
    <DataJobsManager
      displayName={identity.displayName}
      initialView={await getDataJobs(identity, access)}
    />
  );
}
