export const PILOT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
export const PILOT_PROJECT_ID = "00000000-0000-4000-8000-000000000102";

export type OpenRmRuntimeConfiguration = {
  authMode: "development" | "cognito";
  apiBaseUrl: string;
  organizationId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  developmentToken?: string;
  developmentReviewerToken?: string;
  developmentReviewerSubject?: string;
  cognito?: {
    domain: string;
    clientId: string;
    scopes: string[];
  };
};

const developmentConfiguration: OpenRmRuntimeConfiguration = {
  authMode: "development",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8080",
  organizationId: import.meta.env.VITE_OPENRM_ORGANIZATION_ID || PILOT_ORGANIZATION_ID,
  projectId: import.meta.env.VITE_OPENRM_PROJECT_ID || PILOT_PROJECT_ID,
  projectKey: "OPENRM",
  projectName: "OpenRM",
  developmentToken: import.meta.env.VITE_OPENRM_TOKEN || "dev:local-user",
  developmentReviewerToken: import.meta.env.VITE_OPENRM_REVIEWER_TOKEN || "dev:local-reviewer:reviewer",
  developmentReviewerSubject: import.meta.env.VITE_OPENRM_REVIEWER_SUBJECT || "local-reviewer",
};

let activeConfiguration = developmentConfiguration;

function normalized(configuration: OpenRmRuntimeConfiguration): OpenRmRuntimeConfiguration {
  const apiBaseUrl = configuration.apiBaseUrl.trim().replace(/\/$/, "");
  if (configuration.authMode === "cognito") {
    if (!configuration.cognito?.domain.startsWith("https://")) {
      throw new Error("The Cognito domain must use HTTPS");
    }
    if (!configuration.cognito.clientId.trim()) {
      throw new Error("The Cognito client ID is missing");
    }
    if (!configuration.organizationId || !configuration.projectId) {
      throw new Error("The OpenRM organization or project ID is missing");
    }
  }
  return {
    ...configuration,
    apiBaseUrl,
    cognito: configuration.cognito
      ? { ...configuration.cognito, domain: configuration.cognito.domain.replace(/\/$/, "") }
      : undefined,
  };
}

export async function loadRuntimeConfiguration(): Promise<OpenRmRuntimeConfiguration> {
  try {
    const response = await fetch("/openrm-config.json", { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 404) return activeConfiguration;
      throw new Error(`Runtime configuration returned ${response.status}`);
    }
    activeConfiguration = normalized(await response.json() as OpenRmRuntimeConfiguration);
    return activeConfiguration;
  } catch (error) {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return activeConfiguration;
    }
    throw error;
  }
}

export function runtimeConfiguration(): OpenRmRuntimeConfiguration {
  return activeConfiguration;
}
