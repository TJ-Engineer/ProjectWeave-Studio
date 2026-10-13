import { updateOrganizationUserSchema } from "@vibe/contracts";
import {
  getAdministrationSettings,
  updateOrganizationUser,
} from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { userId } = await params;
    const input = await parseBody(request, updateOrganizationUserSchema);
    await updateOrganizationUser(identity, userId, input, requestId);
    return NextResponse.json(await getAdministrationSettings(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
