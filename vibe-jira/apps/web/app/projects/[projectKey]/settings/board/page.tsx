import {
  getBoardSettings,
  getProjectAccess,
  getWorkflowSettings,
} from "@vibe/database";
import { can } from "@vibe/domain";
import { notFound, redirect } from "next/navigation";
import { BoardSettingsManager } from "@/components/board-settings-manager";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function BoardSettingsPage({
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
  const [board, workflow] = await Promise.all([
    getBoardSettings(access),
    getWorkflowSettings(access),
  ]);
  return (
    <BoardSettingsManager
      displayName={identity.displayName}
      initialView={board}
      initialWorkflow={workflow}
    />
  );
}
