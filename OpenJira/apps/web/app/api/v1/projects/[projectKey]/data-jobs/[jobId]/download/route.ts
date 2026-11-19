import { getDataJobDownload, getProjectAccess } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectKey: string; jobId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey, jobId } = await params;
    const access = await getProjectAccess(
      identity.id,
      projectKey.toUpperCase(),
    );
    if (!access) {
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    const output = await getDataJobDownload(identity, access, jobId);
    return new Response(output, {
      headers: {
        "content-disposition": `attachment; filename="${projectKey.toUpperCase()}-issues.csv"`,
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-correlation-id": requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
