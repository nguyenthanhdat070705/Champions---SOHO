// Server-only privileged Postgres access for Functional 03 money/inventory
// paths. Uses the Supabase SESSION POOLER connection string from DATABASE_URL
// (never the client, never committed). This connection bypasses RLS (the pooler
// user has rolbypassrls), so EVERY caller in server/f3 must verify the caller's
// JWT + merchant membership/role BEFORE mutating (NFR-04). RLS remains the
// client's guard; the server is the trusted, audited mutation path.
import pg from "pg";

let pool = null;

/** True when a privileged DB connection is configured (F3 server is active). */
export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** Lazily-created singleton pool. Throws if DATABASE_URL is not configured. */
export function getPool() {
  if (!hasDatabase()) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL.trim(),
      // Supabase pooler terminates TLS with a cert Node won't chain-verify by
      // default; the host is fixed and server-side, so accept it.
      ssl: { rejectUnauthorized: false },
      max: Number.parseInt(process.env.PGPOOL_MAX || "8", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on("error", (err) => {
      console.error("pg pool error", err.message);
    });
  }
  return pool;
}

/** Run a read query outside an explicit transaction. */
export async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run `fn(client)` inside a single BEGIN/COMMIT transaction. Rolls back on any
 * throw and always releases the connection. This is THE boundary for every
 * atomic money/inventory operation in spec §8.1.
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure; original error is what matters
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (used by tests / graceful shutdown). */
export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
