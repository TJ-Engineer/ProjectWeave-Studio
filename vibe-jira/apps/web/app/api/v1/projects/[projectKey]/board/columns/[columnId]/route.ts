import { updateBoardColumnWipLimitSchema } from "@vibe/contracts";
import { getProjectAccess, updateBoardColumnWipLimit } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ projectKey: string; columnId: string }>;
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey, columnId } = await context.params;
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
      "project:admin",
    );
    const input = await parseBody(request, updateBoardColumnWipLimitSchema);
    const column = await updateBoardColumnWipLimit(
      identity,
      access,
      columnId,
      input,
      requestId,
    );
    return NextResponse.json(column, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
