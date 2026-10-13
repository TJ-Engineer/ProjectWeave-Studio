import { csvDryRunSchema } from "@vibe/contracts";
import { dryRunIssueCsv, getProjectAccess } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
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
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "data:manage",
    );
    const input = await parseBody(request, csvDryRunSchema);
    return NextResponse.json(dryRunIssueCsv(input.csv), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
