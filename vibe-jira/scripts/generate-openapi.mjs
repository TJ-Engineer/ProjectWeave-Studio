/* eslint-disable no-undef */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import * as contracts from "@vibe/contracts";
import { format } from "prettier";
import { toJSONSchema } from "zod";

const routeRoot = join(process.cwd(), "apps/web/app/api/v1");
const outputPath = join(process.cwd(), "docs/openapi.json");

async function routes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await routes(path)));
    else if (entry.name === "route.ts") found.push(path);
  }
  return found;
}

function apiPath(file) {
  const parts = relative(routeRoot, file).split(sep).slice(0, -1);
  return (
    "/api/v1/" +
    parts
      .map((part) => (part.startsWith("[") ? `{${part.slice(1, -1)}}` : part))
      .join("/")
  );
}

function operation(path, method, requestSchema, multipart) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const unauthenticated = path.includes("/auth/");
  const tag = path.split("/")[3] ?? "api";
  return {
    tags: [tag],
    summary: `${method.toUpperCase()} ${path}`,
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
    ...(unauthenticated ? {} : { security: [{ sessionCookie: [] }] }),
    ...(parameters.length ? { parameters } : {}),
    ...(requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: `#/components/schemas/${requestSchema}`,
                },
              },
            },
          },
        }
      : {}),
    ...(multipart
      ? {
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
        }
      : {}),
    responses: {
      200: {
        description: "Successful response",
        headers: {
          "x-correlation-id": { schema: { type: "string", format: "uuid" } },
        },
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true },
          },
        },
      },
      400: { $ref: "#/components/responses/ApiError" },
      401: { $ref: "#/components/responses/ApiError" },
      403: { $ref: "#/components/responses/ApiError" },
      404: { $ref: "#/components/responses/ApiError" },
      409: { $ref: "#/components/responses/ApiError" },
      422: { $ref: "#/components/responses/ApiError" },
      429: { $ref: "#/components/responses/ApiError" },
    },
  };
}

const paths = {};
for (const file of (await routes(routeRoot)).sort()) {
  const source = await readFile(file, "utf8");
  const path = apiPath(file);
  paths[path] = {};
  const handlers = [
    ...source.matchAll(
      /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/g,
    ),
  ];
  for (const [index, match] of handlers.entries()) {
    const method = match[1].toLocaleLowerCase();
    const segment = source.slice(
      match.index,
      handlers[index + 1]?.index ?? source.length,
    );
    const requestSchema = /parseBody\(\s*request\s*,\s*([A-Za-z0-9_]+)/s.exec(
      segment,
    )?.[1];
    const multipart =
      method === "post" && segment.includes("request.formData(");
    paths[path][method] = operation(path, method, requestSchema, multipart);
  }
}

const contractComponents = Object.fromEntries(
  Object.entries(contracts).flatMap(([name, value]) => {
    if (!name.endsWith("Schema") || typeof value !== "object" || !value)
      return [];
    try {
      const schema = toJSONSchema(value);
      delete schema.$schema;
      return [[name, schema]];
    } catch {
      return [];
    }
  }),
);

const document = {
  openapi: "3.1.0",
  info: {
    title: "Vibe JIRA API",
    version: process.env.APP_VERSION ?? "0.1.0",
    description:
      "Same-origin Release 1 API. Runtime bodies are validated by the Zod schemas in @vibe/contracts.",
  },
  servers: [{ url: "/", description: "Application origin" }],
  paths,
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "vibe_session" },
    },
    schemas: {
      ...contractComponents,
      ApiError: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "correlationId"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              correlationId: { type: "string" },
              fields: {
                type: "object",
                additionalProperties: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      ApiError: {
        description: "Stable machine-readable error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
    },
  },
};

const generated = await format(JSON.stringify(document), { parser: "json" });
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("docs/openapi.json is stale; run npm run openapi:generate");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated);
}
