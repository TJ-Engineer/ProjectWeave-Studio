import { updateProjectTeamSchema } from "@vibe/contracts";
import {
  getProjectAccess,
  getProjectTeams,
  setProjectTeam,
} from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

async function access(userId: string, projectKey: string) {
  const result = await getProjectAccess(userId, projectKey.toUpperCase());
  if (!result)
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  return result;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectKey: string; teamId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey, teamId } = await params;
    const input = await parseBody(request, updateProjectTeamSchema);
    const projectAccess = await access(identity.id, projectKey);
    await setProjectTeam(
      identity,
      projectAccess,
      teamId,
      input.role,
      requestId,
    );
    return NextResponse.json(await getProjectTeams(identity, projectAccess), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectKey: string; teamId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey, teamId } = await params;
    const projectAccess = await access(identity.id, projectKey);
    await setProjectTeam(identity, projectAccess, teamId, null, requestId);
    return NextResponse.json(await getProjectTeams(identity, projectAccess), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
