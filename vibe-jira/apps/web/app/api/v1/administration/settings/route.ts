import { updateOrganizationSettingsSchema } from "@vibe/contracts";
import {
  getAdministrationSettings,
  updateOrganizationSettings,
} from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    return NextResponse.json(await getAdministrationSettings(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PUT(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const input = await parseBody(request, updateOrganizationSettingsSchema);
    await updateOrganizationSettings(identity, input, requestId);
    return NextResponse.json(await getAdministrationSettings(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
