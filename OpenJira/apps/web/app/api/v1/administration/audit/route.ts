import {
  auditEventsQuerySchema,
  updateAuditRetentionSchema,
} from "@vibe/contracts";
import { getAuditEvents, updateAuditRetention } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseQuery,
  requireIdentity,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const query = parseQuery(request, auditEventsQuerySchema);
    return NextResponse.json(await getAuditEvents(identity, query), {
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
    const input = await parseBody(request, updateAuditRetentionSchema);
    return NextResponse.json(
      await updateAuditRetention(
        identity,
        input.days,
        input.version,
        requestId,
      ),
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
