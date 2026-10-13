import { can } from "@vibe/domain";
import { getProjectAccess, listDeletedIssues } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { DeletedIssuesManager } from "@/components/deleted-issues-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DeletedIssuesPage({
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
    !can(access.organizationRole, access.projectRole, "issue:restore")
  ) {
    notFound();
  }
  const initialView = await listDeletedIssues(identity, access);
  return (
    <DeletedIssuesManager
      displayName={identity.displayName}
      initialView={initialView}
    />
  );
}
