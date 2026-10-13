import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import { correlationId, handleApiError } from "@/lib/api";
import {
  createOidcFlow,
  discoverOidc,
  oidcClientId,
  oidcCookieSecure,
  oidcEnabled,
  oidcPublicUrl,
} from "@/lib/oidc";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    if (!oidcEnabled())
      throw new DomainError(
        "OIDC_NOT_CONFIGURED",
        "OIDC is not configured",
        404,
      );
    const discovery = await discoverOidc();
    const { flow, cookie, challenge } = createOidcFlow();
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: oidcClientId(),
      redirect_uri: `${oidcPublicUrl()}/api/v1/auth/oidc/callback`,
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const response = NextResponse.redirect(authorization);
    response.cookies.set("vibe_oidc_flow", cookie, {
      httpOnly: true,
      secure: oidcCookieSecure(),
      sameSite: "lax",
      maxAge: 600,
      path: "/api/v1/auth/oidc",
    });
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-correlation-id", requestId);
    return response;
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
