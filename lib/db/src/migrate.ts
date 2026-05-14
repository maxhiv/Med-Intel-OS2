/**
 * Applies all pending Drizzle migrations from ./migrations/.
 * Run via: pnpm --filter @workspace/db run migrate
 *
 * In development, `push` / `push-force` is the preferred flow. This migrate
 * script is primarily for production deployments where it is important to
 * track applied migrations via the `__drizzle_migrations` table.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: path.join(__dirname, "./migrations") });
console.log("✅ Migrations applied");
await pool.end();
