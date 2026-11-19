import "server-only";

import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { DomainError } from "@vibe/domain";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new DomainError("OIDC_NOT_CONFIGURED", "OIDC is not configured", 404);
  return value;
}

export function oidcEnabled(): boolean {
  return Boolean(
    process.env.OIDC_ISSUER?.trim() && process.env.OIDC_CLIENT_ID?.trim(),
  );
}

export function oidcPublicUrl(): string {
  return required("PUBLIC_URL").replace(/\/$/, "");
}

function assertSecureUrl(value: string, label: string): URL {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new DomainError(
      "OIDC_INSECURE_ENDPOINT",
      `${label} must use HTTPS`,
      500,
    );
  }
  return url;
}

export async function discoverOidc(): Promise<OidcDiscovery> {
  const issuer = required("OIDC_ISSUER").replace(/\/$/, "");
  assertSecureUrl(issuer, "OIDC issuer");
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new DomainError(
      "OIDC_DISCOVERY_FAILED",
      "OIDC discovery failed",
      502,
    );
  }
  const body = (await response.json()) as Partial<OidcDiscovery>;
  if (
    body.issuer !== issuer ||
    !body.authorization_endpoint ||
    !body.token_endpoint ||
    !body.jwks_uri
  ) {
    throw new DomainError(
      "OIDC_DISCOVERY_INVALID",
      "OIDC discovery is invalid",
      502,
    );
  }
  assertSecureUrl(body.authorization_endpoint, "OIDC authorization endpoint");
  assertSecureUrl(body.token_endpoint, "OIDC token endpoint");
  assertSecureUrl(body.jwks_uri, "OIDC key endpoint");
  return body as OidcDiscovery;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("SESSION_SECRET is required");
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function createOidcFlow(): {
  flow: OidcFlowState;
  cookie: string;
  challenge: string;
} {
  const flow: OidcFlowState = {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    expiresAt: Date.now() + 10 * 60 * 1_000,
  };
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  return {
    flow,
    cookie: `${payload}.${sign(payload)}`,
    challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
  };
}

export function decodeOidcFlow(cookie: string | undefined): OidcFlowState {
  if (!cookie)
    throw new DomainError(
      "OIDC_FLOW_INVALID",
      "OIDC flow cookie is missing",
      400,
    );
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature)
    throw new DomainError(
      "OIDC_FLOW_INVALID",
      "OIDC flow cookie is invalid",
      400,
    );
  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    throw new DomainError(
      "OIDC_FLOW_INVALID",
      "OIDC flow cookie is invalid",
      400,
    );
  }
  const flow = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as OidcFlowState;
  if (
    !flow.state ||
    !flow.nonce ||
    !flow.verifier ||
    flow.expiresAt < Date.now()
  ) {
    throw new DomainError("OIDC_FLOW_EXPIRED", "OIDC sign-in has expired", 400);
  }
  return flow;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export async function exchangeAndVerifyOidc(
  code: string,
  flow: OidcFlowState,
): Promise<VerifiedOidcIdentity> {
  const discovery = await discoverOidc();
  const clientId = required("OIDC_CLIENT_ID");
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
  const redirectUri = `${oidcPublicUrl()}/api/v1/auth/oidc/callback`;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: flow.verifier,
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) {
    throw new DomainError(
      "OIDC_TOKEN_FAILED",
      "OIDC token exchange failed",
      502,
    );
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token)
    throw new DomainError(
      "OIDC_TOKEN_INVALID",
      "OIDC did not return an ID token",
      502,
    );
  const parts = tokens.id_token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new DomainError(
      "OIDC_TOKEN_INVALID",
      "OIDC ID token is invalid",
      403,
    );
  }
  const header = decodeJwtPart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJwtPart<{
    iss?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
    nonce?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  }>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) {
    throw new DomainError(
      "OIDC_TOKEN_ALGORITHM",
      "OIDC ID token must use RS256",
      403,
    );
  }
  const keysResponse = await fetch(discovery.jwks_uri, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!keysResponse.ok)
    throw new DomainError(
      "OIDC_KEYS_FAILED",
      "OIDC signing keys could not be loaded",
      502,
    );
  const keySet = (await keysResponse.json()) as {
    keys?: Array<JsonWebKey & { kid?: string }>;
  };
  const jwk = keySet.keys?.find((key) => key.kid === header.kid);
  if (!jwk)
    throw new DomainError(
      "OIDC_KEY_NOT_FOUND",
      "OIDC signing key was not found",
      403,
    );
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url"),
  );
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid ||
    claims.iss !== discovery.issuer ||
    !claims.sub ||
    !audience.includes(clientId) ||
    !claims.exp ||
    claims.exp <= Date.now() / 1_000 ||
    claims.nonce !== flow.nonce ||
    !claims.email ||
    claims.email_verified === false
  ) {
    throw new DomainError(
      "OIDC_TOKEN_INVALID",
      "OIDC ID token validation failed",
      403,
    );
  }
  const allowedDomain =
    process.env.OIDC_ALLOWED_DOMAIN?.trim().toLocaleLowerCase();
  if (
    allowedDomain &&
    !claims.email.toLocaleLowerCase().endsWith(`@${allowedDomain}`)
  ) {
    throw new DomainError(
      "OIDC_EMAIL_NOT_ALLOWED",
      "This email domain is not allowed",
      403,
    );
  }
  return {
    issuer: discovery.issuer,
    subject: claims.sub,
    email: claims.email,
    displayName:
      claims.name?.trim() || claims.email.split("@")[0] || claims.email,
  };
}

export function oidcCookieSecure(): boolean {
  return oidcPublicUrl().startsWith("https://");
}

export function oidcClientId(): string {
  return required("OIDC_CLIENT_ID");
}
