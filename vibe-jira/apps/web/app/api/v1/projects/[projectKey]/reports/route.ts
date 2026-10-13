import { reportsQuerySchema } from "@vibe/contracts";
import { getKanbanReports, getProjectAccess } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseQuery,
  requireIdentity,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
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
    const query = parseQuery(request, reportsQuerySchema);
    return NextResponse.json(await getKanbanReports(identity, access, query), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
