import {
  deleteCompletionActionSchema,
  updateCompletionActionSchema,
} from "@vibe/contracts";
import {
  deleteCompletionAction,
  getIssueAccess,
  updateCompletionAction,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ issueKey: string; completionActionId: string }>;
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { issueKey, completionActionId } = await context.params;
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    const input = await parseBody(request, updateCompletionActionSchema);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      input.completed === undefined ? "issue:edit" : "issue:transition",
    );
    const issue = await updateCompletionAction(
      identity,
      access,
      issueKey,
      completionActionId,
      input,
      requestId,
    );
    return NextResponse.json(issue, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { issueKey, completionActionId } = await context.params;
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    assertCapability(access.organizationRole, access.projectRole, "issue:edit");
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:delete",
    );
    const input = await parseBody(request, deleteCompletionActionSchema);
    const issue = await deleteCompletionAction(
      identity,
      access,
      issueKey,
      completionActionId,
      input,
      requestId,
    );
    return NextResponse.json(issue, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
