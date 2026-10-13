import { updateProjectMemberSchema } from "@vibe/contracts";
import {
  getProjectAccess,
  removeProjectMember,
  setProjectMember,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ projectKey: string; userId: string }>;
}

async function authorizedRequest(context: Context) {
  const identity = await requireIdentity();
  const { projectKey, userId } = await context.params;
  const access = await getProjectAccess(identity.id, projectKey.toUpperCase());
  if (!access) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "project:admin",
  );
  return { identity, access, userId };
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const { identity, access, userId } = await authorizedRequest(context);
    const input = await parseBody(request, updateProjectMemberSchema);
    const member = await setProjectMember(
      identity,
      access,
      userId,
      input.role,
      requestId,
    );
    return NextResponse.json(member, {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const { identity, access, userId } = await authorizedRequest(context);
    assertSameOrigin(request);
    await removeProjectMember(identity, access, userId, requestId);
    return new NextResponse(null, {
      status: 204,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
