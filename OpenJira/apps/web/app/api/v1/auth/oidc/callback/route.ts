import { completeOidcLogin } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import { correlationId, enforceRateLimit, handleApiError } from "@/lib/api";
import {
  decodeOidcFlow,
  exchangeAndVerifyOidc,
  oidcPublicUrl,
} from "@/lib/oidc";
import { createSession } from "@/lib/session";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    if (error)
      throw new DomainError(
        "OIDC_PROVIDER_ERROR",
        "The identity provider rejected sign-in",
        401,
      );
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("vibe_oidc_flow="))
      ?.slice("vibe_oidc_flow=".length);
    const flow = decodeOidcFlow(
      cookie ? decodeURIComponent(cookie) : undefined,
    );
    if (!state || state !== flow.state || !code) {
      throw new DomainError(
        "OIDC_STATE_INVALID",
        "OIDC state validation failed",
        403,
      );
    }
    await enforceRateLimit(request, "auth.oidc", 20, 60, state);
    const oidc = await exchangeAndVerifyOidc(code, flow);
    const userId = await completeOidcLogin({
      ...oidc,
      autoProvision: process.env.OIDC_AUTO_PROVISION === "true",
      correlationId: requestId,
    });
    await createSession(userId);
    const response = NextResponse.redirect(`${oidcPublicUrl()}/projects`);
    response.cookies.set("vibe_oidc_flow", "", {
      maxAge: 0,
      path: "/api/v1/auth/oidc",
    });
    return response;
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
