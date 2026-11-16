import { currentUserSubject, developmentIdentityToken, getIdentityToken } from "./auth";
import { runtimeConfiguration } from "./config";
import { sessionHeaders } from "./client";

export function runtimeConfig() {
  const configuration = runtimeConfiguration();
  const activeDevelopmentToken = configuration.authMode === "development" ? developmentIdentityToken() : "";
  return {
    baseUrl: configuration.apiBaseUrl,
    organizationId: configuration.organizationId,
    projectId: configuration.projectId,
    projectKey: configuration.projectKey,
    projectName: configuration.projectName,
    token: activeDevelopmentToken,
    reviewerToken: activeDevelopmentToken,
    reviewerSubject: currentUserSubject() || configuration.developmentReviewerSubject || "current-user",
  };
}

export async function apiRequestAs<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const config = runtimeConfig();
  const identityToken = runtimeConfiguration().authMode === "cognito"
    ? await getIdentityToken()
    : token;
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      ...sessionHeaders(identityToken, config.organizationId),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const configuration = runtimeConfiguration();
  const token = configuration.authMode === "development" ? developmentIdentityToken() : "";
  return apiRequestAs(path, token, init);
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
