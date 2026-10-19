import type { FutureDocumentEnvelope } from "./compatibility";
import type { DocumentNode } from "./schema";

export type ReadableDocument = DocumentNode | FutureDocumentEnvelope;
