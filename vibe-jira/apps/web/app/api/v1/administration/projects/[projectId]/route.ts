import { updateAdminProjectSchema } from "@vibe/contracts";
import { getAdministrationSettings, updateAdminProject } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectId } = await params;
    const input = await parseBody(request, updateAdminProjectSchema);
    await updateAdminProject(identity, projectId, input, requestId);
    return NextResponse.json(await getAdministrationSettings(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
