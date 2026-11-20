import { createProjectSchema, paginationQuerySchema } from "@vibe/contracts";
import { createProject, listProjectsPage } from "@vibe/database";
import { assertCapability } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseQuery,
  requireIdentity,
  requireIdempotency,
} from "@/lib/api";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const query = parseQuery(request, paginationQuerySchema);
    const page = await listProjectsPage(identity, query);
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

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    assertCapability(identity.organizationRole, null, "project:create");
    const input = await parseBody(request, createProjectSchema);
    const idempotency = requireIdempotency(request, input);
    const project = await createProject(
      identity,
      input,
      requestId,
      idempotency,
    );
    return NextResponse.json(project, {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
