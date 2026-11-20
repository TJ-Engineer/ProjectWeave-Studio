import type { DocumentNode } from "./schema";
import type {
  FutureDocumentProjection,
  OpenDocumentResult,
} from "./compatibility";
import { openDocument } from "./compatibility";

export interface CanonicalEditorAdapter<EngineDocument> {
  readonly id: string;
  canEdit(document: DocumentNode): boolean;
  toEngine(document: DocumentNode): EngineDocument;
  toCanonical(document: EngineDocument): DocumentNode;
}

export type AdapterOpenResult<EngineDocument> =
  | {
      mode: "editable";
      sourceVersion: number;
      migrated: boolean;
      engineDocument: EngineDocument;
    }
  | {
      mode: "readOnlyCanonical";
      sourceVersion: number;
      document: DocumentNode;
    }
  | {
      mode: "readOnlyFuture";
      sourceVersion: number;
      document: FutureDocumentProjection;
      raw: unknown;
    };

export function openWithAdapter<EngineDocument>(
  input: unknown,
  adapter: CanonicalEditorAdapter<EngineDocument>,
): AdapterOpenResult<EngineDocument> {
  const opened: OpenDocumentResult = openDocument(input);
  if (opened.mode === "readOnlyFuture") return opened;
  if (!adapter.canEdit(opened.document)) {
    return {
      mode: "readOnlyCanonical",
      sourceVersion: opened.sourceVersion,
      document: opened.document,
    };
  }
  return {
    mode: "editable",
    sourceVersion: opened.sourceVersion,
    migrated: opened.migrated,
    engineDocument: adapter.toEngine(opened.document),
  };
}
