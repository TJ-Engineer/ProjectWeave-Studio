import { Pool, type PoolClient, type PoolConfig } from "pg";

declare global {
  var __knowledgePool: Pool | undefined;
}

function configuration(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return {
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? "10"),
    idleTimeoutMillis: 30_000,
  };
}

export function getPool(): Pool {
  if (!globalThis.__knowledgePool) {
    globalThis.__knowledgePool = new Pool(configuration());
  }
  return globalThis.__knowledgePool;
}

export async function inTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__knowledgePool) {
    await globalThis.__knowledgePool.end();
    globalThis.__knowledgePool = undefined;
  }
}
