import { issueLifecycleSchema } from "@vibe/contracts";
import { getDeletedIssueAccess, restoreIssue } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ issueKey: string }>;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { issueKey } = await context.params;
    const access = await getDeletedIssueAccess(identity.id, issueKey);
    if (!access) {
      throw new DomainError(
        "DELETED_ISSUE_NOT_FOUND",
        "Deleted issue not found",
        404,
      );
    }
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:restore",
    );
    const input = await parseBody(request, issueLifecycleSchema);
    const issue = await restoreIssue(
      identity,
      access,
      issueKey,
      input.version,
      requestId,
    );
    return NextResponse.json(issue, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
