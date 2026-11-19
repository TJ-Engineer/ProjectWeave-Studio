import { markAllNotificationsRead } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

export async function PUT(request: Request) {
  const requestId = correlationId(request);
  try {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    return NextResponse.json(
      { updated: await markAllNotificationsRead(identity) },
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
