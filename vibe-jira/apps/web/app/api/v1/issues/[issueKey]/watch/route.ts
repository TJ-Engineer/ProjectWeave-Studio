import { getIssueAccess, setIssueWatching } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ issueKey: string }>;
}

async function updateWatching(
  request: Request,
  context: Context,
  watching: boolean,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { issueKey } = await context.params;
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:watch",
    );
    return NextResponse.json(
      await setIssueWatching(identity, access, issueKey, watching, requestId),
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  return updateWatching(request, context, true);
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  return updateWatching(request, context, false);
}
