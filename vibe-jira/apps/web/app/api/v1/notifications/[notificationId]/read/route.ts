import { markNotificationRead } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

export async function PUT(
  request: Request,
  context: { params: Promise<{ notificationId: string }> },
) {
  const requestId = correlationId(request);
  try {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { notificationId } = await context.params;
    await markNotificationRead(identity, notificationId);
    return NextResponse.json(
      { read: true },
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
