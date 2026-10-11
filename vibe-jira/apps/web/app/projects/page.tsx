import { redirect } from "next/navigation";
import { listProjects } from "@vibe/database";
import { ProjectHub } from "@/components/project-hub";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const projects = await listProjects(identity);
  return (
    <ProjectHub displayName={identity.displayName} initialProjects={projects} />
  );
}
