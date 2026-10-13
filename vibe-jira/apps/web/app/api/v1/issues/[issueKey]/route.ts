import { issueLifecycleSchema, updateIssueSchema } from "@vibe/contracts";
import {
  deleteIssue,
  getIssueAccess,
  getIssueDetail,
  updateIssue,
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
    const issue = await getIssueDetail(issueKey, access);
    if (!issue)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    return NextResponse.json(issue, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PATCH(
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
    assertCapability(access.organizationRole, access.projectRole, "issue:edit");
    const input = await parseBody(request, updateIssueSchema);
    const issue = await updateIssue(
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

export async function DELETE(
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
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:delete",
    );
    const input = await parseBody(request, issueLifecycleSchema);
    await deleteIssue(identity, access, issueKey, input.version, requestId);
    return new NextResponse(null, {
      status: 204,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
