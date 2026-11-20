import { createCsvImportJobSchema } from "@vibe/contracts";
import { createDataJob, getProjectAccess } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
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
    const { projectKey } = await params;
    const access = await getProjectAccess(
      identity.id,
      projectKey.toUpperCase(),
    );
    if (!access) {
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    const input = await parseBody(request, createCsvImportJobSchema);
    const idempotency = requireIdempotency(request, input);
    return NextResponse.json(
      await createDataJob(
        identity,
        access,
        { jobType: "CSV_IMPORT", ...input },
        idempotency.key,
        requestId,
      ),
      { status: 202, headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
