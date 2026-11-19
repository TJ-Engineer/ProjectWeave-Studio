import { getProjectAccess, getProjectTeams } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { ProjectTeamsManager } from "@/components/project-teams-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProjectTeamsPage({
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
    <ProjectTeamsManager
      displayName={identity.displayName}
      initialView={await getProjectTeams(identity, access)}
    />
  );
}
