import { getProjectAccess, listProjectMembers } from "@vibe/database";
import { can } from "@vibe/domain";
import { notFound, redirect } from "next/navigation";
import { ProjectMembersManager } from "@/components/project-members-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProjectMembersPage({
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
    !can(access.organizationRole, access.projectRole, "project:admin")
  ) {
    notFound();
  }
  const initialView = await listProjectMembers(identity, access);
  return (
    <ProjectMembersManager
      displayName={identity.displayName}
      initialView={initialView}
    />
  );
}
