import { movePageSchema } from "@knowledge/contracts";
import { movePage } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseUuidPath,
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
    const { pageId: value } = await context.params;
    const pageId = parseUuidPath(value, "pageId");
    return NextResponse.json(
      await movePage(
        await requireIdentity(),
        pageId,
        await parseBody(request, movePageSchema),
        id,
      ),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
