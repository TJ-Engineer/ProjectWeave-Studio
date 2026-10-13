import { paginationQuerySchema } from "@vibe/contracts";
import {
  listNotifications,
  processNotificationOutboxBatch,
} from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseQuery,
  requireIdentity,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const query = parseQuery(request, paginationQuerySchema);
    await processNotificationOutboxBatch(50);
    return NextResponse.json(await listNotifications(identity, query), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
