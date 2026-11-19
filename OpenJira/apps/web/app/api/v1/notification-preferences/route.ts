import { notificationPreferencesSchema } from "@vibe/contracts";
import {
  getNotificationPreferences,
  setNotificationPreferences,
} from "@vibe/database";
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
    const identity = await requireIdentity();
    return NextResponse.json(await getNotificationPreferences(identity), {
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
    const input = await parseBody(request, notificationPreferencesSchema);
    return NextResponse.json(
      await setNotificationPreferences(identity, input, requestId),
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
