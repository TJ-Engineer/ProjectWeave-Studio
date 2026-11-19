import { restoreRevisionSchema } from "@knowledge/contracts";
import { restoreRevision } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parsePositiveIntegerPath,
  parseUuidPath,
  requireIdempotencyKey,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string; number: string }>;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId: pageValue, number: numberValue } = await context.params;
    const pageId = parseUuidPath(pageValue, "pageId");
    const number = parsePositiveIntegerPath(numberValue, "number");
    const revision = await restoreRevision(
      await requireIdentity(),
      pageId,
      number,
      await parseBody(request, restoreRevisionSchema),
      requireIdempotencyKey(request),
      id,
    );
    return NextResponse.json(
      { revision },
      { status: 201, headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
