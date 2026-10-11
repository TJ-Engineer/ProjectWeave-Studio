import { can } from "@vibe/domain";
import { getBoard, getBoardAccess, getIssueDetail } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { Board } from "@/components/board";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string; boardId: string }>;
  searchParams: Promise<{ issue?: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { projectKey, boardId } = await params;
  const access = await getBoardAccess(identity.id, boardId);
  if (!access || access.projectKey !== projectKey.toUpperCase()) notFound();
  if (!can(access.organizationRole, access.projectRole, "issue:view"))
    notFound();
  const board = await getBoard(boardId, access);
  if (!board) notFound();
  const requestedIssue = (await searchParams).issue;
  const initialSelected = requestedIssue?.startsWith(`${access.projectKey}-`)
    ? await getIssueDetail(requestedIssue, access)
    : null;
  return (
    <Board
      initialBoard={board}
      initialSelected={initialSelected}
      displayName={identity.displayName}
      canEditIssues={can(
        access.organizationRole,
        access.projectRole,
        "issue:edit",
      )}
    />
  );
}
