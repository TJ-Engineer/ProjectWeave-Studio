import { updateTeamSchema } from "@vibe/contracts";
import { getAdministrationTeams, updateTeam } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { teamId } = await params;
    const input = await parseBody(request, updateTeamSchema);
    await updateTeam(identity, teamId, input, requestId);
    return NextResponse.json(await getAdministrationTeams(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
