import { saveDraftSchema } from "@knowledge/contracts";
import { saveDraft } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string }>;
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId } = await context.params;
    const draft = await saveDraft(
      await requireIdentity(),
      pageId,
      await parseBody(request, saveDraftSchema),
    );
    return NextResponse.json(
      { draft },
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
