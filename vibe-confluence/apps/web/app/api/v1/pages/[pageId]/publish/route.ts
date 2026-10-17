import { publishPageSchema } from "@knowledge/contracts";
import { publishPage } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdempotencyKey,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string }>;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId } = await context.params;
    const revision = await publishPage(
      await requireIdentity(),
      pageId,
      await parseBody(request, publishPageSchema),
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
