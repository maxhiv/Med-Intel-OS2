import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type DB = NodePgDatabase<typeof schema>;

const baseDb: DB = drizzle(pool, { schema });

/**
 * Per-request transaction-bound drizzle instance plus the account id whose
 * `app.account_id` session var is currently engaged. When set (via
 * `withRLS`), the exported `db` proxy routes every query through `db` so
 * row-level security policies stay in effect for the entire scope.
 */
type RLSContext = { db: DB; accountId: string };
const rlsStorage = new AsyncLocalStorage<RLSContext>();

/**
 * `db` is a Proxy: inside an `withRLS` async context it delegates to a
 * transaction-bound drizzle instance (so RLS policies engage); outside any
 * such context it falls through to the pool-backed instance. Routes can keep
 * using `db` exactly as before — tenant isolation becomes a database-level
 * guarantee, not just an application-filter promise.
 */
export const db: DB = new Proxy(baseDb, {
  get(target, prop, receiver) {
    const ctx = rlsStorage.getStore();
    const source = (ctx?.db ?? target) as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(source, prop, source);
    return typeof value === "function" ? (value as Function).bind(source) : value;
  },
}) as DB;

/**
 * Run `fn` inside a Postgres transaction with `app.account_id` set to
 * `accountId`. Inside `fn`, every use of the exported `db` is routed through
 * the transaction client, so RLS policies on tenant-scoped tables enforce
 * isolation even if a query forgets its `WHERE account_id = ?` clause.
 *
 * Commits on normal return, rolls back on thrown error.
 *
 * Re-entrancy: if we're already inside an RLS scope for the same account
 * (e.g. a service wrapper inside a request that the middleware already
 * wrapped), `fn` runs directly in the existing transaction — no nested
 * BEGIN/COMMIT, no extra connection. Calling with a *different* accountId
 * inside an active scope throws: that would silently smuggle one tenant's
 * code into another tenant's transaction, which is exactly the bug the
 * helper exists to prevent.
 */
export async function withRLS<T>(
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = rlsStorage.getStore();
  if (existing) {
    if (existing.accountId !== accountId) {
      throw new Error(
        `withRLS nested with conflicting accountId: outer=${existing.accountId} inner=${accountId}`,
      );
    }
    return await fn();
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Drop down to a non-superuser, non-BYPASSRLS role so RLS policies
    // actually apply. Without this step, a connection authenticated as a
    // superuser (the default in many managed Postgres setups) would silently
    // ignore every policy and tenant isolation would be only a route-level
    // promise.
    await client.query("SET LOCAL ROLE app_rls");
    await client.query("SELECT set_config('app.account_id', $1, true)", [
      accountId,
    ]);
    const txDb: DB = drizzle(client, { schema });
    const result = await rlsStorage.run({ db: txDb, accountId }, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export * from "./schema";
