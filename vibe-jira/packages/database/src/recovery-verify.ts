import { closePool, getPool } from "./client";
import { signedAttachmentUrl } from "./object-storage";

async function main(): Promise<void> {
  const attachments = await getPool().query<{
    object_key: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  }>(
    `SELECT object_key, filename, content_type, size_bytes
       FROM attachments
      WHERE scan_state = 'CLEAN' AND deleted_at IS NULL
      ORDER BY id`,
  );
  for (const attachment of attachments.rows) {
    const response = await fetch(
      signedAttachmentUrl(
        attachment.object_key,
        attachment.filename,
        attachment.content_type,
        60,
      ),
    );
    if (!response.ok) {
      throw new Error(
        `Restored attachment ${attachment.object_key} returned ${response.status}`,
      );
    }
    const content = await response.arrayBuffer();
    if (content.byteLength !== attachment.size_bytes) {
      throw new Error(
        `Restored attachment ${attachment.object_key} has ${content.byteLength} bytes; expected ${attachment.size_bytes}`,
      );
    }
  }
  console.log(
    `Verified ${attachments.rowCount ?? attachments.rows.length} restored attachment objects`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
