import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { UserIdentity } from "@vibe/contracts";
import { getIdentity } from "@vibe/database";

const cookieName = "vibe_session";
const sessionLifetimeSeconds = 60 * 60 * 12;

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
}

function encodeSession(userId: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${signature(payload)}`;
}

function sessionCookieSecure(): boolean {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  return publicUrl
    ? new URL(publicUrl).protocol === "https:"
    : process.env.NODE_ENV === "production";
}

function decodeSession(value: string): string | null {
  const [userId, expiresAtValue, providedSignature] = value.split(".");
  if (!userId || !expiresAtValue || !providedSignature) return null;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000)
    return null;
  const payload = `${userId}.${expiresAtValue}`;
  const expected = Buffer.from(signature(payload));
  const provided = Buffer.from(providedSignature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    return null;
  return userId;
}

export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(cookieName, encodeSession(userId), {
    httpOnly: true,
    secure: sessionCookieSecure(),
    sameSite: "lax",
    maxAge: sessionLifetimeSeconds,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(cookieName);
}

export async function currentIdentity(): Promise<UserIdentity | null> {
  const store = await cookies();
  const value = store.get(cookieName)?.value;
  if (!value) return null;
  const userId = decodeSession(value);
  return userId ? getIdentity(userId) : null;
}
