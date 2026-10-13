import { getOutboxHealth } from "@vibe/database";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    return NextResponse.json(await getOutboxHealth(identity), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
