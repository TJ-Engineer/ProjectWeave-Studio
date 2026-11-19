import { inviteOrganizationUserSchema } from "@vibe/contracts";
import {
  getAdministrationSettings,
  inviteOrganizationUser,
} from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const input = await parseBody(request, inviteOrganizationUserSchema);
    const configuredBase = process.env.PUBLIC_URL;
    const publicBaseUrl = configuredBase ?? new URL(request.url).origin;
    const invitation = await inviteOrganizationUser(
      identity,
      input,
      publicBaseUrl,
      requestId,
    );
    return NextResponse.json(
      {
        settings: await getAdministrationSettings(identity),
        ...invitation,
      },
      { status: 201, headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
