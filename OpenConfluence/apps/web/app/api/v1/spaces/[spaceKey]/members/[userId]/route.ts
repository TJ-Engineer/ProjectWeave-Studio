import {
  removeSpaceMemberSchema,
  spaceKeySchema,
  upsertSpaceMemberSchema,
} from "@knowledge/contracts";
import { removeSpaceMember, upsertSpaceMember } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parseBody,
  parseUuidPath,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ spaceKey: string; userId: string }>;
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { spaceKey: keyValue, userId: userValue } = await context.params;
    const spaceKey = spaceKeySchema.parse(keyValue);
    const userId = parseUuidPath(userValue, "userId");
    return NextResponse.json(
      await upsertSpaceMember(
        await requireIdentity(),
        spaceKey,
        userId,
        await parseBody(request, upsertSpaceMemberSchema),
        id,
      ),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { spaceKey: keyValue, userId: userValue } = await context.params;
    const spaceKey = spaceKeySchema.parse(keyValue);
    const userId = parseUuidPath(userValue, "userId");
    const input = await parseBody(request, removeSpaceMemberSchema);
    return NextResponse.json(
      await removeSpaceMember(
        await requireIdentity(),
        spaceKey,
        userId,
        input.expectedMembershipVersion,
        id,
      ),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
