import { createDataJob, getProjectAccess } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  enforceRateLimit,
  handleApiError,
  requireIdempotency,
  requireIdentity,
} from "@/lib/api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectKey: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    await enforceRateLimit(request, "data.export", 10, 60, identity.id);
    assertSameOrigin(request);
    const { projectKey } = await params;
    const access = await getProjectAccess(
      identity.id,
      projectKey.toUpperCase(),
    );
    if (!access) {
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    const idempotency = requireIdempotency(request, { jobType: "CSV_EXPORT" });
    return NextResponse.json(
      await createDataJob(
        identity,
        access,
        { jobType: "CSV_EXPORT" },
        idempotency.key,
        requestId,
      ),
      { status: 202, headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
