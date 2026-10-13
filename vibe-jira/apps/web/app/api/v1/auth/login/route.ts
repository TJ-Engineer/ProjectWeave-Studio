import { loginSchema } from "@vibe/contracts";
import { findUserForLogin } from "@vibe/database";
import { DomainError, verifyPassword } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  enforceRateLimit,
  handleApiError,
  parseBody,
} from "@/lib/api";
import { createSession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const input = await parseBody(request, loginSchema);
    await enforceRateLimit(
      request,
      "auth.login",
      Number(process.env.LOGIN_RATE_LIMIT_MAX ?? "10"),
      60,
      input.email,
    );
    if (
      process.env.NODE_ENV === "production" &&
      process.env.OIDC_ISSUER &&
      process.env.ALLOW_PASSWORD_AUTH !== "true"
    ) {
      throw new DomainError(
        "PASSWORD_AUTH_DISABLED",
        "Use the configured identity provider to sign in",
        403,
      );
    }
    const user = await findUserForLogin(input.email);
    if (
      !user ||
      user.state !== "ACTIVE" ||
      !(await verifyPassword(input.password, user.passwordHash))
    ) {
      throw new DomainError(
        "INVALID_CREDENTIALS",
        "Email or password is incorrect",
        401,
      );
    }
    await createSession(user.id);
    return NextResponse.json(
      { ok: true },
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
