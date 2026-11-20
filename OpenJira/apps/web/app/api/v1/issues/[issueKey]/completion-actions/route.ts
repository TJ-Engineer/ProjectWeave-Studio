import { createCompletionActionSchema } from "@vibe/contracts";
import {
  createCompletionAction,
  getIssueAccess,
  getIssueDetail,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
  requireIdempotency,
} from "@/lib/api";

interface Context {
  params: Promise<{ issueKey: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { issueKey } = await context.params;
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    assertCapability(access.organizationRole, access.projectRole, "issue:view");
    const issue = await getIssueDetail(issueKey, access);
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    return NextResponse.json(issue.completionActions, {
      headers: { "cache-control": "no-store", "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
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
    if (!access) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    assertCapability(access.organizationRole, access.projectRole, "issue:edit");
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:create",
    );
    const input = await parseBody(request, createCompletionActionSchema);
    const idempotency = requireIdempotency(request, input);
    const issue = await createCompletionAction(
      identity,
      access,
      issueKey,
      input,
      requestId,
      idempotency,
    );
    return NextResponse.json(issue, {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
