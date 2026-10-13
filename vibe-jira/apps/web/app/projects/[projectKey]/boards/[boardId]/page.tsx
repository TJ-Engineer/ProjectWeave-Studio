import { can } from "@vibe/domain";
import { boardIssuesQuerySchema, swimlaneModeSchema } from "@vibe/contracts";
import {
  getBoardAccess,
  getBoardPage,
  getIssueDetail,
  listBoardQuickFilters,
} from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { Board, type BoardFilterState } from "@/components/board";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string; boardId: string }>;
  searchParams: Promise<{
    issue?: string;
    swimlane?: string;
    q?: string;
    type?: string;
    priority?: string;
    assignee?: string;
    label?: string;
    epic?: string;
  }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { projectKey, boardId } = await params;
  const access = await getBoardAccess(identity.id, boardId);
  if (!access || access.projectKey !== projectKey.toUpperCase()) notFound();
  if (!can(access.organizationRole, access.projectRole, "issue:view"))
    notFound();
  const query = await searchParams;
  const requestedFilters = boardIssuesQuerySchema.safeParse({
    limit: 50,
    ...(query.q ? { q: query.q } : {}),
    ...(query.type ? { issueType: query.type } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.assignee ? { assignee: query.assignee } : {}),
    ...(query.label ? { label: query.label } : {}),
    ...(query.epic ? { epicKey: query.epic } : {}),
  });
  const boardQuery = requestedFilters.success
    ? requestedFilters.data
    : boardIssuesQuerySchema.parse({ limit: 50 });
  const board = await getBoardPage(boardId, access, boardQuery);
  if (!board) notFound();
  const quickFilters = await listBoardQuickFilters(identity, access);
  const requestedIssue = query.issue;
  const requestedSwimlane = swimlaneModeSchema.safeParse(query.swimlane);
  const initialSelected = requestedIssue?.startsWith(`${access.projectKey}-`)
    ? await getIssueDetail(requestedIssue, access)
    : null;
  const initialFilters: BoardFilterState = {
    q: boardQuery.q ?? "",
    issueType: boardQuery.issueType ?? "",
    priority: boardQuery.priority ?? "",
    assignee: boardQuery.assignee ?? "",
    label: boardQuery.label ?? "",
    epicKey: boardQuery.epicKey ?? "",
  };
  return (
    <Board
      key={JSON.stringify(initialFilters)}
      initialBoard={board}
      initialSelected={initialSelected}
      initialSwimlane={
        requestedSwimlane.success ? requestedSwimlane.data : "none"
      }
      initialFilters={initialFilters}
      quickFilters={quickFilters}
      displayName={identity.displayName}
      canEditIssues={can(
        access.organizationRole,
        access.projectRole,
        "issue:edit",
      )}
      canDeleteIssues={can(
        access.organizationRole,
        access.projectRole,
        "issue:delete",
      )}
      canCreateIssues={can(
        access.organizationRole,
        access.projectRole,
        "issue:create",
      )}
      canTransitionIssues={can(
        access.organizationRole,
        access.projectRole,
        "issue:transition",
      )}
      canComment={can(
        access.organizationRole,
        access.projectRole,
        "comment:create",
      )}
      canWatch={can(access.organizationRole, access.projectRole, "issue:watch")}
      canAttach={can(
        access.organizationRole,
        access.projectRole,
        "attachment:create",
      )}
      canManageProject={can(
        access.organizationRole,
        access.projectRole,
        "project:admin",
      )}
    />
  );
}
