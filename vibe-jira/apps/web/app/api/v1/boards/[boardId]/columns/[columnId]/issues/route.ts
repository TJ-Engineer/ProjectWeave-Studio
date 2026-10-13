import { boardIssuesQuerySchema } from "@vibe/contracts";
import { getBoardAccess, listBoardColumnIssuesPage } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseQuery,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ boardId: string; columnId: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { boardId, columnId } = await context.params;
    const access = await getBoardAccess(identity.id, boardId);
    if (!access)
      throw new DomainError("BOARD_NOT_FOUND", "Board not found", 404);
    assertCapability(access.organizationRole, access.projectRole, "issue:view");
    const page = await listBoardColumnIssuesPage(
      access,
      boardId,
      columnId,
      parseQuery(request, boardIssuesQuerySchema),
    );
    return NextResponse.json(page, {
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
