import { acceptInvitationSchema } from "@vibe/contracts";
import { acceptUserInvitation } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  enforceRateLimit,
  handleApiError,
  parseBody,
} from "@/lib/api";
import { createSession } from "@/lib/session";

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    const input = await parseBody(request, acceptInvitationSchema);
    await enforceRateLimit(request, "auth.invitation", 10, 60, input.token);
    const userId = await acceptUserInvitation(
      input.token,
      input.password,
      requestId,
    );
    await createSession(userId);
    return NextResponse.json(
      { ok: true },
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
