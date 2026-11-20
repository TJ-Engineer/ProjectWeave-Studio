import { redirect } from "next/navigation";
import { listProjectsPage } from "@vibe/database";
import { ProjectHub } from "@/components/project-hub";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const projects = await listProjectsPage(identity, { limit: 25 });
  return (
    <ProjectHub
      displayName={identity.displayName}
      canAdminister={identity.organizationRole === "ADMIN"}
      initialProjects={projects.items}
      initialNextCursor={projects.nextCursor}
    />
  );
}
