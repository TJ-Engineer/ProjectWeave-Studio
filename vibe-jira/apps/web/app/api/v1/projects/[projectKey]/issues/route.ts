import { createIssueSchema } from "@vibe/contracts";
import { createIssue, getProjectAccess } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ projectKey: string }>;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await context.params;
    const access = await getProjectAccess(
      identity.id,
      projectKey.toUpperCase(),
    );
    if (!access)
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:create",
    );
    const input = await parseBody(request, createIssueSchema);
    const issue = await createIssue(identity, access, input, requestId);
    return NextResponse.json(issue, {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
