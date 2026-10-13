import {
  deleteAttachmentObject,
  deleteIssueAttachment,
  getIssueAccess,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

export async function DELETE(
  request: Request,
  context: {
    params: Promise<{ issueKey: string; attachmentId: string }>;
  },
) {
  const requestId = correlationId(request);
  try {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { issueKey, attachmentId } = await context.params;
    const access = await getIssueAccess(identity.id, issueKey);
    if (!access) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "attachment:delete",
    );
    const { objectKey } = await deleteIssueAttachment(
      identity,
      access,
      issueKey,
      attachmentId,
      requestId,
    );
    await deleteAttachmentObject(objectKey).catch((error: unknown) => {
      console.error(JSON.stringify({ correlationId: requestId, error }));
    });
    return new NextResponse(null, {
      status: 204,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
