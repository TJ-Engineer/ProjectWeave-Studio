import { createTeamSchema } from "@vibe/contracts";
import { createTeam, getAdministrationTeams } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    return NextResponse.json(
      await getAdministrationTeams(await requireIdentity()),
      {
        headers: { "x-correlation-id": requestId },
      },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const input = await parseBody(request, createTeamSchema);
    await createTeam(identity, input.name, requestId);
    return NextResponse.json(await getAdministrationTeams(identity), {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
