export type LogLevel = "debug" | "info" | "warn" | "error";

export function buildInformation(): {
  version: string;
  revision: string;
} {
  return {
    version: process.env.APP_VERSION ?? "development",
    revision: process.env.APP_REVISION ?? "unknown",
  };
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) =>
        !/(password|secret|token|authorization|cookie|description|body)/i.test(
          key,
        ),
    ),
  );
}

export function structuredLog(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: process.env.SERVICE_NAME ?? "vibe-jira",
    ...buildInformation(),
    ...safeFields(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export async function measure<T>(
  operation: string,
  work: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();
  try {
    const result = await work();
    structuredLog("info", "operation.completed", {
      operation,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...fields,
    });
    return result;
  } catch (error) {
    structuredLog("error", "operation.failed", {
      operation,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      error: error instanceof Error ? error.message : "Unknown error",
      ...fields,
    });
    throw error;
  }
}
