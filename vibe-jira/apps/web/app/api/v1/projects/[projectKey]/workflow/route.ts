import { updateWorkflowConfigurationSchema } from "@vibe/contracts";
import {
  getProjectAccess,
  getWorkflowSettings,
  updateWorkflowConfiguration,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ projectKey: string }>;
}

async function workflowAccess(projectKey: string, userId: string) {
  const access = await getProjectAccess(userId, projectKey.toUpperCase());
  if (!access) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "project:admin",
  );
  return access;
}

export async function GET(request: Request, context: Context) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await context.params;
    const access = await workflowAccess(projectKey, identity.id);
    return NextResponse.json(await getWorkflowSettings(access), {
      headers: { "cache-control": "no-store", "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PUT(request: Request, context: Context) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { projectKey } = await context.params;
    const access = await workflowAccess(projectKey, identity.id);
    const input = await parseBody(request, updateWorkflowConfigurationSchema);
    return NextResponse.json(
      await updateWorkflowConfiguration(identity, access, input, requestId),
      { headers: { "x-correlation-id": requestId } },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
