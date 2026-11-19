export type ManualBlock =
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "note"; text: string }
  | { type: "code"; text: string }
  | { type: "subheading"; id: string; title: string };

export type ManualSection = {
  id: string;
  title: string;
  blocks: ManualBlock[];
};

export type ManualMetadata = {
  documentVersion: string;
  appliesTo: string;
  owner: string;
  lastVerified: string;
  status: string;
};

export type ManualDocument = {
  $schema: "./USER_MANUAL.schema.json";
  schemaVersion: 1;
  title: string;
  summary: string;
  metadata: ManualMetadata;
  intro: ManualBlock[];
  sections: ManualSection[];
};

type UnknownRecord = Record<string, unknown>;

const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_BLOCK_TYPES = new Set(["paragraph", "note", "code"]);

function fail(path: string, message: string): never {
  throw new Error(`Invalid user manual at ${path}: ${message}`);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as UnknownRecord;
}

function asString(value: unknown, path: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function asStableId(value: unknown, path: string) {
  const id = asString(value, path);
  if (!STABLE_ID.test(id)) {
    fail(path, "expected a lowercase, hyphen-separated stable identifier");
  }
  return id;
}

function asStringArray(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, "expected a non-empty string array");
  }
  return value.map((item, index) => asString(item, `${path}[${index}]`));
}

function parseBlock(value: unknown, path: string): ManualBlock {
  const block = asRecord(value, path);
  const type = asString(block.type, `${path}.type`);

  if (type === "subheading") {
    return {
      type,
      id: asStableId(block.id, `${path}.id`),
      title: asString(block.title, `${path}.title`),
    };
  }

  if (type === "unordered-list" || type === "ordered-list") {
    return {
      type,
      items: asStringArray(block.items, `${path}.items`),
    };
  }

  if (TEXT_BLOCK_TYPES.has(type)) {
    return {
      type: type as "paragraph" | "note" | "code",
      text: asString(block.text, `${path}.text`),
    };
  }

  return fail(`${path}.type`, `unsupported block type "${type}"`);
}

function parseBlocks(value: unknown, path: string) {
  if (!Array.isArray(value)) fail(path, "expected a block array");
  return value.map((block, index) => parseBlock(block, `${path}[${index}]`));
}

function parseMetadata(value: unknown): ManualMetadata {
  const metadata = asRecord(value, "metadata");
  const lastVerified = asString(metadata.lastVerified, "metadata.lastVerified");
  const parsedDate = new Date(`${lastVerified}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastVerified)
    || Number.isNaN(parsedDate.valueOf())
    || parsedDate.toISOString().slice(0, 10) !== lastVerified) {
    fail("metadata.lastVerified", "expected a valid ISO calendar date in YYYY-MM-DD format");
  }

  return {
    documentVersion: asString(metadata.documentVersion, "metadata.documentVersion"),
    appliesTo: asString(metadata.appliesTo, "metadata.appliesTo"),
    owner: asString(metadata.owner, "metadata.owner"),
    lastVerified,
    status: asString(metadata.status, "metadata.status"),
  };
}

export function parseManual(source: unknown): ManualDocument {
  const document = asRecord(source, "document");
  if (document.$schema !== "./USER_MANUAL.schema.json") {
    fail("$schema", "expected the colocated USER_MANUAL.schema.json reference");
  }
  if (document.schemaVersion !== 1) {
    fail("schemaVersion", "only schema version 1 is supported");
  }
  if (!Array.isArray(document.sections) || document.sections.length === 0) {
    fail("sections", "expected at least one manual section");
  }

  const seenAnchors = new Set<string>();
  const sections = document.sections.map((value, sectionIndex): ManualSection => {
    const path = `sections[${sectionIndex}]`;
    const section = asRecord(value, path);
    const id = asStableId(section.id, `${path}.id`);
    const blocks = parseBlocks(section.blocks, `${path}.blocks`);

    for (const anchor of [id, ...blocks.filter((block) => block.type === "subheading").map((block) => block.id)]) {
      if (seenAnchors.has(anchor)) fail(path, `duplicate anchor "${anchor}"`);
      seenAnchors.add(anchor);
    }

    return {
      id,
      title: asString(section.title, `${path}.title`),
      blocks,
    };
  });

  return {
    $schema: "./USER_MANUAL.schema.json",
    schemaVersion: 1,
    title: asString(document.title, "title"),
    summary: asString(document.summary, "summary"),
    metadata: parseMetadata(document.metadata),
    intro: parseBlocks(document.intro, "intro"),
    sections,
  };
}

export function sectionSearchText(section: ManualSection) {
  const blockText = section.blocks.map((block) => {
    if ("items" in block) return block.items.join(" ");
    if (block.type === "subheading") return block.title;
    return block.text;
  });
  return [section.title, ...blockText].join(" ").toLowerCase();
}
