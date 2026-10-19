import { z } from "zod";
import {
  CURRENT_SCHEMA_VERSION,
  DOCUMENT_LIMITS,
  type DocumentNode,
  assertDocumentSize,
} from "./schema";
import { migrateDocument } from "./migrations";

const documentEnvelopeSchema = z
  .object({
    type: z.literal("doc"),
    schemaVersion: z.number().int().positive(),
    content: z.array(z.unknown()).max(DOCUMENT_LIMITS.nodes),
  })
  .passthrough();

export interface FutureNodePlaceholder {
  type: "unsupported";
  originalType: string;
  raw: unknown;
}

export interface FutureDocumentEnvelope {
  type: "doc";
  schemaVersion: number;
  content: unknown[];
  [key: string]: unknown;
}

export interface FutureDocumentProjection {
  type: "doc";
  schemaVersion: number;
  content: FutureNodePlaceholder[];
}

export type OpenDocumentResult =
  | {
      mode: "editable";
      sourceVersion: number;
      migrated: boolean;
      document: DocumentNode;
    }
  | {
      mode: "readOnlyFuture";
      sourceVersion: number;
      document: FutureDocumentProjection;
      raw: FutureDocumentEnvelope;
    };

function originalType(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return value.type.slice(0, 100);
  }
  return "unknown";
}

export function openDocument(input: unknown): OpenDocumentResult {
  assertDocumentSize(input);
  const envelope = documentEnvelopeSchema.parse(input);
  if (envelope.schemaVersion <= CURRENT_SCHEMA_VERSION) {
    return {
      mode: "editable",
      sourceVersion: envelope.schemaVersion,
      migrated: envelope.schemaVersion !== CURRENT_SCHEMA_VERSION,
      document: migrateDocument(input),
    };
  }
  return {
    mode: "readOnlyFuture",
    sourceVersion: envelope.schemaVersion,
    document: {
      type: "doc",
      schemaVersion: envelope.schemaVersion,
      content: envelope.content.map((raw) => ({
        type: "unsupported",
        originalType: originalType(raw),
        raw,
      })),
    },
    raw: envelope,
  };
}
