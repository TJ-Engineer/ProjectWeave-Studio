import { createIssueSchema, paginationQuerySchema } from "@vibe/contracts";
import { createIssue, getProjectAccess, listIssuesPage } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseQuery,
  requireIdentity,
  requireIdempotency,
} from "@/lib/api";

interface Context {
  params: Promise<{ projectKey: string }>;
}

async function accessForRequest(identityId: string, projectKey: string) {
  const access = await getProjectAccess(identityId, projectKey.toUpperCase());
  if (!access)
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  return access;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await context.params;
    const access = await accessForRequest(identity.id, projectKey);
    assertCapability(access.organizationRole, access.projectRole, "issue:view");
    const query = parseQuery(request, paginationQuerySchema);
    const page = await listIssuesPage(access, query);
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

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await context.params;
    const access = await accessForRequest(identity.id, projectKey);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "issue:create",
    );
    const input = await parseBody(request, createIssueSchema);
    const idempotency = requireIdempotency(request, input);
    const issue = await createIssue(
      identity,
      access,
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
