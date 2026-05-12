/**
 * Ensure required Postgres extensions exist *before* `drizzle-kit push`
 * applies the schema.
 *
 * The schema declares GIN trigram indexes (e.g. `idx_facilities_name_trgm`)
 * that reference the `gin_trgm_ops` operator class, which only exists once
 * the `pg_trgm` extension has been created. Drizzle-kit's push does not
 * manage extensions, and the seed script (which used to be the only place
 * extensions were enabled) runs *after* push — so on a fresh database the
 * push would fail before seed ever ran.
 *
 * This script is idempotent and safe to run repeatedly. It mirrors the
 * extension list in `seed.ts` for ones the schema actually depends on.
 */
import { pool } from "./index";

async function main() {
  const client = await pool.connect();
  try {
    // uuid-ossp: powers `default uuid_generate_v4()` on every primary key.
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    // pg_trgm: required by the GIN trigram indexes on `facilities`.
    await client.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    console.log("✓ Extensions ensured (uuid-ossp, pg_trgm)");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ensure-extensions failed:", err);
  process.exit(1);
});
