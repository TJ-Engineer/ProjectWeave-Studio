import {
  createSavedFilterSchema,
  savedFiltersQuerySchema,
} from "@vibe/contracts";
import { createSavedFilter, listSavedFilters } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseQuery,
  requireIdentity,
} from "@/lib/api";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const query = parseQuery(request, savedFiltersQuerySchema);
    return NextResponse.json(
      await listSavedFilters(identity, query.projectKey),
      {
        headers: {
          "cache-control": "no-store",
          "x-correlation-id": requestId,
        },
      },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const input = await parseBody(request, createSavedFilterSchema);
    return NextResponse.json(
      await createSavedFilter(identity, input, requestId),
      {
        status: 201,
        headers: { "x-correlation-id": requestId },
      },
    );
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
