import { createHash, createHmac } from "node:crypto";
import { connect } from "node:net";
import { DomainError } from "@vibe/domain";

export const maximumAttachmentBytes = 10 * 1024 * 1024;

const allowedTypes = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
]);

function safeFilename(filename: string): string {
  const normalized = filename
    .normalize("NFC")
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!normalized || normalized.length > 255) {
    throw new DomainError(
      "INVALID_ATTACHMENT_NAME",
      "Attachment names must contain 1-255 safe characters",
      422,
    );
  }
  return normalized;
}

function hasBytes(value: Uint8Array, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => value[offset + index] === byte);
}

function contentMatches(contentType: string, body: Uint8Array): boolean {
  if (contentType === "application/pdf") {
    return hasBytes(body, [0x25, 0x50, 0x44, 0x46]);
  }
  if (contentType === "image/png") {
    return hasBytes(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg") {
    return hasBytes(body, [0xff, 0xd8, 0xff]);
  }
  if (contentType === "image/gif") {
    const header = new TextDecoder().decode(body.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  if (contentType === "image/webp") {
    return (
      new TextDecoder().decode(body.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(body.slice(8, 12)) === "WEBP"
    );
  }
  try {
    if (body.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

export function validateAttachment(
  filename: string,
  contentType: string,
  body: Uint8Array,
): { filename: string; contentType: string; sizeBytes: number } {
  const normalizedType = contentType.toLowerCase().split(";", 1)[0]!.trim();
  if (!allowedTypes.has(normalizedType)) {
    throw new DomainError(
      "ATTACHMENT_TYPE_NOT_ALLOWED",
      "Use PDF, PNG, JPEG, GIF, WebP, plain text, or CSV files",
      422,
    );
  }
  if (body.byteLength === 0 || body.byteLength > maximumAttachmentBytes) {
    throw new DomainError(
      "ATTACHMENT_SIZE_INVALID",
      "Attachments must contain data and be no larger than 10 MB",
      413,
    );
  }
  if (!contentMatches(normalizedType, body)) {
    throw new DomainError(
      "ATTACHMENT_CONTENT_MISMATCH",
      "The file contents do not match the declared type",
      422,
    );
  }
  return {
    filename: safeFilename(filename),
    contentType: normalizedType,
    sizeBytes: body.byteLength,
  };
}

interface StorageConfiguration {
  endpoint: URL;
  publicEndpoint: URL;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

function storageConfiguration(): StorageConfiguration {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY;
  const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY;
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("Object storage configuration is required");
  }
  return {
    endpoint: new URL(endpoint),
    publicEndpoint: new URL(
      process.env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? endpoint,
    ),
    region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? "vibe-jira-attachments",
    accessKey,
    secretKey,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(
  configuration: StorageConfiguration,
  key: string,
): string {
  return `/${awsEncode(configuration.bucket)}/${key
    .split("/")
    .map(awsEncode)
    .join("/")}`;
}

function signingKey(
  secretKey: string,
  shortDate: string,
  region: string,
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${secretKey}`, shortDate), region), "s3"),
    "aws4_request",
  );
}

function dateParts(date: Date): { timestamp: string; shortDate: string } {
  const timestamp = date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace("Z", "Z");
  return { timestamp, shortDate: timestamp.slice(0, 8) };
}

function requestUrl(endpoint: URL, path: string, query = ""): URL {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = query;
  return url;
}

async function signedObjectRequest(
  method: "PUT" | "DELETE",
  key: string,
  body?: Uint8Array,
  contentType?: string,
): Promise<void> {
  const configuration = storageConfiguration();
  const path = key
    ? canonicalPath(configuration, key)
    : `/${awsEncode(configuration.bucket)}`;
  const now = new Date();
  const { timestamp, shortDate } = dateParts(now);
  const payloadHash = sha256(body ?? new Uint8Array());
  const host = configuration.endpoint.host;
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${shortDate}/${configuration.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(configuration.secretKey, shortDate, configuration.region),
  )
    .update(stringToSign)
    .digest("hex");
  const request: RequestInit = {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${configuration.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
  if (body) request.body = Uint8Array.from(body).buffer;
  const response = await fetch(
    requestUrl(configuration.endpoint, path),
    request,
  );
  if (!response.ok && !(key === "" && response.status === 409)) {
    throw new Error(`Object storage ${method} failed with ${response.status}`);
  }
}

export async function putAttachmentObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await signedObjectRequest("PUT", "");
  await signedObjectRequest("PUT", key, body, contentType);
}

export async function deleteAttachmentObject(key: string): Promise<void> {
  await signedObjectRequest("DELETE", key);
}

export function signedAttachmentUrl(
  key: string,
  filename: string,
  contentType: string,
  expiresSeconds = 300,
): string {
  const configuration = storageConfiguration();
  const path = canonicalPath(configuration, key);
  const { timestamp, shortDate } = dateParts(new Date());
  const scope = `${shortDate}/${configuration.region}/s3/aws4_request`;
  const query = new Map<string, string>([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${configuration.accessKey}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(Math.max(1, Math.min(expiresSeconds, 900)))],
    ["X-Amz-SignedHeaders", "host"],
    ["response-content-type", contentType],
    [
      "response-content-disposition",
      `attachment; filename*=UTF-8''${awsEncode(filename)}`,
    ],
  ]);
  const canonicalQuery = [...query]
    .sort(([left], [right]) => {
      const encodedLeft = awsEncode(left);
      const encodedRight = awsEncode(right);
      return encodedLeft < encodedRight
        ? -1
        : encodedLeft > encodedRight
          ? 1
          : 0;
    })
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    "GET",
    path,
    canonicalQuery,
    `host:${configuration.publicEndpoint.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(configuration.secretKey, shortDate, configuration.region),
  )
    .update(stringToSign)
    .digest("hex");
  return requestUrl(
    configuration.publicEndpoint,
    path,
    `${canonicalQuery}&X-Amz-Signature=${signature}`,
  ).toString();
}

export async function scanAttachment(
  body: Uint8Array,
): Promise<"CLEAN" | "REJECTED"> {
  const host = process.env.CLAMAV_HOST;
  if (!host) throw new Error("CLAMAV_HOST is required for attachment scanning");
  const port = Number(process.env.CLAMAV_PORT ?? "3310");
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        const response = Buffer.concat(chunks).toString("utf8");
        if (response.includes("FOUND")) resolve("REJECTED");
        else if (response.includes("OK")) resolve("CLEAN");
        else
          reject(new Error(`Unexpected malware scanner response: ${response}`));
      }
    };
    socket.setTimeout(15_000, () =>
      finish(new Error("Malware scan timed out")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.includes(0) || chunk.includes(10)) finish();
    });
    socket.once("connect", () => {
      socket.write("zINSTREAM\0");
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(body.byteLength);
      socket.write(length);
      socket.write(body);
      socket.write(Buffer.alloc(4));
    });
  });
}
