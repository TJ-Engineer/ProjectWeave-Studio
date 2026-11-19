import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { UserIdentity } from "@knowledge/contracts";
import { getIdentity } from "@knowledge/database";
import { cookies } from "next/headers";

const cookieName = "knowledge_session";
const sessionLifetimeSeconds = 60 * 60 * 12;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(userId: string): string {
  const expiresAt = Math.floor(Date.now() / 1_000) + sessionLifetimeSeconds;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${signature(payload)}`;
}

function decode(value: string): string | null {
  const [userId, expiresAtValue, providedValue] = value.split(".");
  if (!userId || !expiresAtValue || !providedValue) return null;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1_000)
    return null;
  const expected = Buffer.from(signature(`${userId}.${expiresAtValue}`));
  const provided = Buffer.from(providedValue);
  return expected.length === provided.length &&
    timingSafeEqual(expected, provided)
    ? userId
    : null;
}

function secureCookie(): boolean {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  return publicUrl
    ? new URL(publicUrl).protocol === "https:"
    : process.env.NODE_ENV === "production";
}

export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(cookieName, encode(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(),
    maxAge: sessionLifetimeSeconds,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(cookieName);
}

export async function currentIdentity(): Promise<UserIdentity | null> {
  const value = (await cookies()).get(cookieName)?.value;
  const userId = value ? decode(value) : null;
  return userId ? getIdentity(userId) : null;
}
