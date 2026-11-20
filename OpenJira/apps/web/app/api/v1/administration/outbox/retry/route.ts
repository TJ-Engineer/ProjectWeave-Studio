import { retryOutboxEventSchema } from "@vibe/contracts";
import { getOutboxHealth, retryOutboxEvent } from "@vibe/database";
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
    const input = await parseBody(request, retryOutboxEventSchema);
    await retryOutboxEvent(identity, input.eventId, requestId);
    return NextResponse.json(await getOutboxHealth(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
