import { NextResponse } from "next/server";
import { assertSameOrigin, correlationId, handleApiError } from "@/lib/api";
import { destroySession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    assertSameOrigin(request);
    await destroySession();
    return NextResponse.json(
      { ok: true },
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
