import { restoreRevisionSchema } from "@knowledge/contracts";
import { restoreRevision } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
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
    const { pageId, number: value } = await context.params;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new DomainError(
        "INVALID_REVISION",
        "Revision number is invalid",
        400,
      );
    }
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
