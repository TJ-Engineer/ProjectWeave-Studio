import { randomUUID } from "node:crypto";
import type { AttachmentView } from "@vibe/contracts";
import {
  createIssueAttachment,
  deleteAttachmentObject,
  getIssueAccess,
  getIssueAttachments,
  putAttachmentObject,
  scanAttachment,
  signedAttachmentUrl,
  validateAttachment,
  type StoredAttachmentView,
} from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  correlationId,
  enforceRateLimit,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

export const dynamic = "force-dynamic";

function publicAttachment(attachment: StoredAttachmentView): AttachmentView {
  const { objectKey, ...view } = attachment;
  return {
    ...view,
    downloadUrl:
      attachment.scanState === "CLEAN"
        ? signedAttachmentUrl(
            objectKey,
            attachment.filename,
            attachment.contentType,
          )
        : null,
  };
}

async function accessFor(identityId: string, issueKey: string) {
  const access = await getIssueAccess(identityId, issueKey);
  if (!access) {
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  }
  return access;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ issueKey: string }> },
) {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { issueKey } = await context.params;
    const access = await accessFor(identity.id, issueKey);
    assertCapability(access.organizationRole, access.projectRole, "issue:view");
    const attachments = await getIssueAttachments(identity, access, issueKey);
    return NextResponse.json(attachments.map(publicAttachment), {
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ issueKey: string }> },
) {
  const requestId = correlationId(request);
  let storedObjectKey: string | null = null;
  try {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    await enforceRateLimit(request, "attachment.upload", 20, 60, identity.id);
    const { issueKey } = await context.params;
    const access = await accessFor(identity.id, issueKey);
    assertCapability(
      access.organizationRole,
      access.projectRole,
      "attachment:create",
    );
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new DomainError(
        "INVALID_MULTIPART_BODY",
        "Upload one file using multipart form data",
        400,
      );
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new DomainError(
        "ATTACHMENT_REQUIRED",
        "A file field is required",
        400,
      );
    }
    const body = new Uint8Array(await file.arrayBuffer());
    const metadata = validateAttachment(file.name, file.type, body);
    const attachmentId = randomUUID();
    const objectKey = `${identity.organizationId}/${attachmentId}`;
    let scanState: "CLEAN" | "REJECTED" | "ERROR";
    try {
      scanState = await scanAttachment(body);
    } catch (error) {
      console.error(JSON.stringify({ correlationId: requestId, error }));
      scanState = "ERROR";
    }
    if (scanState === "CLEAN") {
      try {
        await putAttachmentObject(objectKey, body, metadata.contentType);
        storedObjectKey = objectKey;
      } catch (error) {
        console.error(JSON.stringify({ correlationId: requestId, error }));
        scanState = "ERROR";
      }
    }
    const attachment = await createIssueAttachment(
      identity,
      access,
      issueKey,
      {
        id: attachmentId,
        objectKey,
        ...metadata,
        scanState,
      },
      requestId,
    );
    storedObjectKey = null;
    return NextResponse.json(publicAttachment(attachment), {
      status: 201,
      headers: { "x-correlation-id": requestId },
    });
  } catch (error) {
    if (storedObjectKey) {
      await deleteAttachmentObject(storedObjectKey).catch(() => undefined);
    }
    return handleApiError(error, requestId);
  }
}
