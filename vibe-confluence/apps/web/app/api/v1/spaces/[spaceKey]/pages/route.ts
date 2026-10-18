import { createPageSchema, spaceKeySchema } from "@knowledge/contracts";
import { createPage, listPages } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ spaceKey: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { spaceKey: value } = await context.params;
    const spaceKey = spaceKeySchema.parse(value);
    return NextResponse.json(
      await listPages(await requireIdentity(), spaceKey),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}

export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { spaceKey: value } = await context.params;
    const spaceKey = spaceKeySchema.parse(value);
    const page = await createPage(
      await requireIdentity(),
      spaceKey,
      await parseBody(request, createPageSchema),
      id,
    );
    return NextResponse.json(
      { page },
      { status: 201, headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
