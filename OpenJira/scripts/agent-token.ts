import { randomUUID } from "node:crypto";
import {
  closePool,
  createAgentApiToken,
  listAgentApiTokens,
  revokeAgentApiToken,
} from "@vibe/database";

type Command = "create" | "list" | "revoke";

const usageText = `Usage:
  npm run agent-token -- create --user EMAIL --actor EMAIL --name NAME [--organization UUID] [--expires-in-days 90]
  npm run agent-token -- list --user EMAIL --actor EMAIL [--organization UUID]
  npm run agent-token -- revoke --id UUID --actor EMAIL`;

function usage(): never {
  throw new Error(usageText);
}

function parseOptions(values: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) usage();
    if (options.has(key)) throw new Error(`Duplicate option: ${key}`);
    options.set(key, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(): Promise<void> {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    process.stdout.write(`${usageText}\n`);
    return;
  }
  const command = process.argv[2] as Command | undefined;
  if (!command || !["create", "list", "revoke"].includes(command)) usage();
  const options = parseOptions(process.argv.slice(3));
  if (command === "create") {
    const expiresValue = options.get("--expires-in-days") ?? "90";
    const expiresInDays = Number(expiresValue);
    const organizationId = options.get("--organization");
    const created = await createAgentApiToken({
      userEmail: required(options, "--user"),
      actorEmail: required(options, "--actor"),
      name: required(options, "--name"),
      ...(organizationId ? { organizationId } : {}),
      expiresInDays,
      correlationId: randomUUID(),
    });
    output(created);
    process.stderr.write(
      "Store the token now; Vibe JIRA stores only its digest and cannot display it again.\n",
    );
    return;
  }
  if (command === "list") {
    const organizationId = options.get("--organization");
    output(
      await listAgentApiTokens({
        userEmail: required(options, "--user"),
        actorEmail: required(options, "--actor"),
        ...(organizationId ? { organizationId } : {}),
      }),
    );
    return;
  }
  output(
    await revokeAgentApiToken({
      tokenId: required(options, "--id"),
      actorEmail: required(options, "--actor"),
      correlationId: randomUUID(),
    }),
  );
}

run()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(closePool);
