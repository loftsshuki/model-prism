import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";

export type DatabaseClient = PoolClient;
export async function transaction<T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured");
  neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  let client: DatabaseClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client?.release(); await pool.end(); }
}
