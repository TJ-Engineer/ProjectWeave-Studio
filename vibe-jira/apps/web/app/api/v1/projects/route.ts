import { createProjectSchema } from "@vibe/contracts";
import { createProject, listProjects } from "@vibe/database";
import { assertCapability } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const projects = await listProjects(identity);
    return NextResponse.json(
      { projects },
      { headers: { "x-correlation-id": requestId } },
    );
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
    const project = await createProject(identity, input, requestId);
    return NextResponse.json(project, {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
