import { transitionIssueSchema } from "@vibe/contracts";
import { getIssueAccess, transitionIssue } from "@vibe/database";
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
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:transition",
    );
    const input = await parseBody(request, transitionIssueSchema);
    const issue = await transitionIssue(
      identity,
      access,
      issueKey,
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
