import { updatePageRestrictionSchema } from "@knowledge/contracts";
import {
  getPageRestrictionAdministration,
  updatePageRestriction,
} from "@knowledge/database";
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

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId: value } = await context.params;
    const pageId = parseUuidPath(value, "pageId");
    return NextResponse.json(
      await getPageRestrictionAdministration(await requireIdentity(), pageId),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId: value } = await context.params;
    const pageId = parseUuidPath(value, "pageId");
    return NextResponse.json(
      await updatePageRestriction(
        await requireIdentity(),
        pageId,
        await parseBody(request, updatePageRestrictionSchema),
        id,
      ),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
