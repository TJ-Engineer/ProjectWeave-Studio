import { createCommentSchema } from "@vibe/contracts";
import {
  createIssueComment,
  getIssueAccess,
  getIssueCollaboration,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdempotency,
  requireIdentity,
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
    if (!access)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    assertCapability(access.organizationRole, access.projectRole, "issue:view");
    return NextResponse.json(
      await getIssueCollaboration(access, issueKey, identity.id),
      {
        headers: { "cache-control": "no-store", "x-correlation-id": requestId },
      },
    );
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
    if (!access)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "comment:create",
    );
    const input = await parseBody(request, createCommentSchema);
    return NextResponse.json(
      await createIssueComment(
        identity,
        access,
        issueKey,
        input.body,
        requestId,
        requireIdempotency(request, input),
      ),
      { status: 201, headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
