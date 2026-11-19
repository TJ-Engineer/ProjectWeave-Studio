import { createSpaceSchema } from "@knowledge/contracts";
import { createSpace, listSpaces } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  requireIdentity,
} from "@/lib/api";

export async function GET(request: Request): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    return NextResponse.json(
      { spaces: await listSpaces(await requireIdentity()) },
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const identity = await requireIdentity();
    const input = await parseBody(request, createSpaceSchema);
    const space = await createSpace(identity, input, id);
    return NextResponse.json(
      { space },
      { status: 201, headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
