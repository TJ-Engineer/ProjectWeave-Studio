import { runtimeConfiguration } from "./config";

type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

type StoredTokens = TokenResponse & { received_at: number };

export type AuthenticatedUser = {
  subject: string;
  email?: string;
  displayName: string;
};

export type DevelopmentProfileRole = "administrator" | "author" | "reviewer" | "viewer";

export type DevelopmentProfile = AuthenticatedUser & {
  role: DevelopmentProfileRole;
};

export type AuthenticationState =
  | { authenticated: true; user: AuthenticatedUser }
  | { authenticated: false; user: null };

const TOKENS_KEY = "openrm.auth.tokens";
const STATE_KEY = "openrm.auth.state";
const VERIFIER_KEY = "openrm.auth.verifier";
const NONCE_KEY = "openrm.auth.nonce";
const DEVELOPMENT_PROFILE_KEY_PREFIX = "openrm.auth.development-profile";
const DEVELOPMENT_ROLES: DevelopmentProfileRole[] = ["administrator", "author", "reviewer", "viewer"];

function developmentProfileKey(): string {
  return `${DEVELOPMENT_PROFILE_KEY_PREFIX}.${runtimeConfiguration().organizationId}`;
}

function configuredDevelopmentProfile(): DevelopmentProfile {
  const configuredToken = runtimeConfiguration().developmentToken || "dev:local-user";
  const tokenValue = configuredToken.startsWith("dev:") ? configuredToken.slice(4) : "local-user";
  const separator = tokenValue.lastIndexOf(":");
  const subjectValue = separator >= 0 ? tokenValue.slice(0, separator) : tokenValue;
  const roleValue = separator >= 0 ? tokenValue.slice(separator + 1) : "";
  const hasRole = DEVELOPMENT_ROLES.includes(roleValue as DevelopmentProfileRole);
  const subject = hasRole ? subjectValue : tokenValue;
  return {
    subject: subject || "local-user",
    displayName: subject === "local-user" || !subject ? "Local user" : subject,
    role: hasRole ? roleValue as DevelopmentProfileRole : "administrator",
  };
}

export function selectedDevelopmentProfile(): DevelopmentProfile | null {
  if (runtimeConfiguration().authMode !== "development") return null;
  const stored = localStorage.getItem(developmentProfileKey());
  if (!stored) return null;
  try {
    const profile = JSON.parse(stored) as Partial<DevelopmentProfile>;
    if (!profile.subject?.trim() || !profile.displayName?.trim() || !DEVELOPMENT_ROLES.includes(profile.role as DevelopmentProfileRole)) {
      localStorage.removeItem(developmentProfileKey());
      return null;
    }
    return {
      subject: profile.subject.trim(),
      displayName: profile.displayName.trim(),
      email: profile.email?.trim() || undefined,
      role: profile.role as DevelopmentProfileRole,
    };
  } catch {
    localStorage.removeItem(developmentProfileKey());
    return null;
  }
}

export function selectDevelopmentProfile(profile: DevelopmentProfile): void {
  if (runtimeConfiguration().authMode !== "development") {
    throw new Error("Profile switching is available only in development mode");
  }
  if (!profile.subject.trim() || !profile.displayName.trim() || !DEVELOPMENT_ROLES.includes(profile.role)) {
    throw new Error("The selected development profile is invalid");
  }
  localStorage.setItem(developmentProfileKey(), JSON.stringify({
    subject: profile.subject.trim(),
    displayName: profile.displayName.trim(),
    email: profile.email?.trim() || undefined,
    role: profile.role,
  }));
}

export function clearDevelopmentProfile(): void {
  localStorage.removeItem(developmentProfileKey());
}

export function developmentIdentityToken(): string {
  const selected = selectedDevelopmentProfile();
  return selected
    ? `dev:${selected.subject}:${selected.role}`
    : runtimeConfiguration().developmentToken || "dev:local-user";
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomValue(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The identity token is malformed");
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (value) => value.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function storedTokens(): StoredTokens | null {
  const value = sessionStorage.getItem(TOKENS_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as StoredTokens;
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

function storeTokens(tokens: TokenResponse, previousRefreshToken?: string) {
  const value: StoredTokens = {
    ...tokens,
    refresh_token: tokens.refresh_token || previousRefreshToken,
    received_at: Date.now(),
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(value));
}

function tokenExpiresSoon(token: string): boolean {
  const expiration = Number(decodeClaims(token).exp || 0) * 1000;
  return expiration <= Date.now() + 60_000;
}

function userFromToken(token: string): AuthenticatedUser {
  const claims = decodeClaims(token);
  const subject = String(claims.sub || "");
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const displayName = typeof claims.name === "string"
    ? claims.name
    : email || String(claims["cognito:username"] || subject || "OpenRM user");
  return { subject, email, displayName };
}

async function tokenRequest(parameters: URLSearchParams): Promise<TokenResponse> {
  const configuration = runtimeConfiguration();
  if (!configuration.cognito) throw new Error("Cognito is not configured");
  const response = await fetch(`${configuration.cognito.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
  });
  const payload = await response.json().catch(() => null) as (TokenResponse & { error?: string }) | null;
  if (!response.ok || !payload?.id_token) {
    throw new Error(payload?.error || "Cognito token exchange failed");
  }
  return payload;
}

async function exchangeAuthorizationCode(code: string, returnedState: string | null) {
  const configuration = runtimeConfiguration();
  if (!configuration.cognito) throw new Error("Cognito is not configured");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedNonce = sessionStorage.getItem(NONCE_KEY);
  if (!expectedState || !verifier || returnedState !== expectedState) {
    throw new Error("The sign-in response did not match this browser session");
  }
  const redirectUri = `${window.location.origin}/`;
  const tokens = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: configuration.cognito.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }));
  const claims = decodeClaims(tokens.id_token);
  if (!expectedNonce || claims.nonce !== expectedNonce) {
    throw new Error("The sign-in identity token failed nonce validation");
  }
  storeTokens(tokens);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(NONCE_KEY);
  window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
}

async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
  const configuration = runtimeConfiguration();
  if (!configuration.cognito || !tokens.refresh_token) {
    throw new Error("The OpenRM session has expired");
  }
  const refreshed = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: configuration.cognito.clientId,
    refresh_token: tokens.refresh_token,
  }));
  storeTokens(refreshed, tokens.refresh_token);
  return storedTokens()!;
}

export async function initializeAuthentication(): Promise<AuthenticationState> {
  const configuration = runtimeConfiguration();
  if (configuration.authMode === "development") {
    const profile = selectedDevelopmentProfile() || configuredDevelopmentProfile();
    return {
      authenticated: true,
      user: { subject: profile.subject, email: profile.email, displayName: profile.displayName },
    };
  }

  const query = new URLSearchParams(window.location.search);
  const authenticationError = query.get("error_description") || query.get("error");
  if (authenticationError) throw new Error(authenticationError);
  const code = query.get("code");
  if (code) await exchangeAuthorizationCode(code, query.get("state"));

  let tokens = storedTokens();
  if (!tokens) return { authenticated: false, user: null };
  try {
    if (tokenExpiresSoon(tokens.id_token)) tokens = await refreshTokens(tokens);
    return { authenticated: true, user: userFromToken(tokens.id_token) };
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return { authenticated: false, user: null };
  }
}

export async function beginSignIn(): Promise<void> {
  const configuration = runtimeConfiguration();
  if (!configuration.cognito) throw new Error("Cognito is not configured");
  const verifier = randomValue(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = randomValue();
  const nonce = randomValue();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(NONCE_KEY, nonce);
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: configuration.cognito.clientId,
    redirect_uri: `${window.location.origin}/`,
    scope: configuration.cognito.scopes.join(" "),
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  window.location.assign(`${configuration.cognito.domain}/oauth2/authorize?${parameters}`);
}

export async function getIdentityToken(): Promise<string> {
  const configuration = runtimeConfiguration();
  if (configuration.authMode === "development") {
    return developmentIdentityToken();
  }
  let tokens = storedTokens();
  if (!tokens) throw new Error("Sign in to continue");
  if (tokenExpiresSoon(tokens.id_token)) tokens = await refreshTokens(tokens);
  return tokens.id_token;
}

export function currentUserSubject(): string {
  const configuration = runtimeConfiguration();
  if (configuration.authMode === "development") {
    return selectedDevelopmentProfile()?.subject || configuredDevelopmentProfile().subject;
  }
  const tokens = storedTokens();
  return tokens ? userFromToken(tokens.id_token).subject : "";
}

export async function signOut(): Promise<void> {
  const configuration = runtimeConfiguration();
  const tokens = storedTokens();
  sessionStorage.removeItem(TOKENS_KEY);
  if (configuration.authMode === "development") {
    clearDevelopmentProfile();
    window.location.reload();
    return;
  }
  if (!configuration.cognito) {
    window.location.reload();
    return;
  }
  if (tokens?.refresh_token) {
    await fetch(`${configuration.cognito.domain}/oauth2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.cognito.clientId,
        token: tokens.refresh_token,
      }),
    }).catch(() => undefined);
  }
  const parameters = new URLSearchParams({
    client_id: configuration.cognito.clientId,
    logout_uri: `${window.location.origin}/`,
  });
  window.location.assign(`${configuration.cognito.domain}/logout?${parameters}`);
}
