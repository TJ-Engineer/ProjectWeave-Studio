import { loginSchema } from "@knowledge/contracts";
import { authenticateDevelopmentUser } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, parseBody } from "@/lib/api";
import { createSession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    if (process.env.ENABLE_DEVELOPMENT_LOGIN !== "true") {
      throw new DomainError(
        "DEVELOPMENT_LOGIN_DISABLED",
        "Development login is disabled",
        404,
      );
    }
    const input = await parseBody(request, loginSchema);
    const identity = await authenticateDevelopmentUser(
      input.email,
      input.password,
    );
    if (!identity)
      throw new DomainError(
        "INVALID_CREDENTIALS",
        "Invalid email or password",
        401,
      );
    await createSession(identity.id);
    return NextResponse.json(
      { user: identity },
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
