import { getProjectAccess, getProjectTeams } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectKey: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await params;
    const access = await getProjectAccess(
      identity.id,
      projectKey.toUpperCase(),
    );
    if (!access)
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    return NextResponse.json(await getProjectTeams(identity, access), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
