import { issueLifecycleSchema, updateSavedFilterSchema } from "@vibe/contracts";
import {
  deleteSavedFilter,
  getSavedFilter,
  updateSavedFilter,
} from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ filterId: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { filterId } = await context.params;
    const filter = await getSavedFilter(identity, filterId);
    if (!filter) {
      throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 404);
    }
    return NextResponse.json(filter, {
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { filterId } = await context.params;
    const input = await parseBody(request, updateSavedFilterSchema);
    return NextResponse.json(
      await updateSavedFilter(identity, filterId, input, requestId),
      { headers: { "x-correlation-id": requestId } },
    );
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
    const identity = await requireIdentity();
    const { filterId } = await context.params;
    const input = await parseBody(request, issueLifecycleSchema);
    await deleteSavedFilter(identity, filterId, input.version, requestId);
    return new NextResponse(null, {
      status: 204,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
