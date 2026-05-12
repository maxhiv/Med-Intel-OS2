/**
 * Seed script — run after `pnpm --filter @workspace/db push`.
 *
 * - Enables Postgres extensions (uuid-ossp, pg_trgm, unaccent).
 *   pgvector is best-effort: skipped silently if not installed.
 * - Enables RLS on tenant-scoped tables and creates isolation policies.
 * - Pre-seeds enrichment_source_approvals for all paid sources (approved=false).
 * - Creates the platform admin Hansen Holdings account if missing.
 */
import { pool } from "./index";

const PLATFORM_ADMIN_EMAIL =
  process.env.PLATFORM_ADMIN_EMAIL || "max@hansenholdingsllc.com";

const PAID_SOURCES = [
  "apollo",
  "netrows",
  "zerobounce",
  "bouncer",
  "twilio",
  "people_data_labs",
  "zoominfo",
  "definitive_hc",
  "openpermit",
];

const RLS_TABLES = [
  "account_facilities",
  "campaigns",
  "campaign_contacts",
  "sequences",
  "contact_enrollments",
  "outreach_drafts",
  "sync_batches",
  "reply_events",
  "report_templates",
  "report_runs",
  "report_schedules",
  "con_alert_subscriptions",
  "con_alert_notifications",
];

async function main() {
  const client = await pool.connect();
  try {
    console.log("→ Enabling extensions");
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "unaccent"');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "vector"');
      console.log("  ✓ pgvector enabled");
    } catch (e) {
      console.warn("  ⚠ pgvector not available, semantic search disabled");
    }

    console.log("→ Ensuring app_rls role (non-superuser, non-bypass) for RLS");
    // Postgres superusers and BYPASSRLS roles ignore RLS even with FORCE.
    // We create a NOLOGIN, non-superuser, non-bypass role and have the
    // app `SET LOCAL ROLE app_rls` inside each request transaction so the
    // policies actually apply.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
          CREATE ROLE app_rls NOLOGIN NOSUPERUSER NOBYPASSRLS;
        ELSE
          ALTER ROLE app_rls NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    // Grant on existing + future objects so the role can read/write all
    // tables; RLS policies still gate which rows it actually sees.
    await client.query(`GRANT USAGE ON SCHEMA public TO app_rls`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT USAGE, SELECT ON SEQUENCES TO app_rls`,
    );
    // Allow the connecting role to SET ROLE app_rls
    await client.query(
      `GRANT app_rls TO CURRENT_USER`,
    );

    console.log("→ Enabling RLS policies");
    for (const table of RLS_TABLES) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      // FORCE so the table owner / superuser is also subject to policies —
      // otherwise the app's own DB role bypasses RLS and isolation is moot.
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS ${table}_isolation ON ${table}`);
      if (table === "report_templates") {
        await client.query(
          `CREATE POLICY ${table}_isolation ON ${table}
             USING (is_system_template = TRUE
                    OR account_id = NULLIF(current_setting('app.account_id', true), '')::UUID)`,
        );
      } else {
        await client.query(
          `CREATE POLICY ${table}_isolation ON ${table}
             USING (account_id = NULLIF(current_setting('app.account_id', true), '')::UUID)`,
        );
      }
    }

    console.log("→ Seeding enrichment_source_approvals");
    for (const source of PAID_SOURCES) {
      await client.query(
        `INSERT INTO enrichment_source_approvals (source, approved)
         VALUES ($1::enrichment_source, false)
         ON CONFLICT (source) DO NOTHING`,
        [source],
      );
    }

    console.log("→ Ensuring Hansen Holdings platform admin account");
    const acctRes = await client.query(
      `INSERT INTO accounts (name, slug, plan_tier, status)
       VALUES ('Hansen Holdings LLC', 'hansen-holdings', 'internal', 'active')
       ON CONFLICT (slug) DO UPDATE SET status='active'
       RETURNING id`,
    );
    const accountId = acctRes.rows[0].id;
    await client.query(
      `INSERT INTO users (account_id, email, role, first_name, last_name)
       VALUES ($1, $2, 'platform_admin', 'Platform', 'Admin')
       ON CONFLICT (email) DO UPDATE SET role='platform_admin', account_id=$1`,
      [accountId, PLATFORM_ADMIN_EMAIL],
    );

    console.log("→ Seeding default sequence/report templates (system)");
    await client.query(
      `INSERT INTO report_templates (name, description, category, data_sources, field_config, is_system_template, is_active)
       VALUES
         ('Top Signal Facilities', 'Facilities with highest signal scores', 'signals',
          ARRAY['facilities','purchase_signals'],
          '[{"field":"name","label":"Facility"},{"field":"signal_score","label":"Score"}]'::jsonb,
          true, true),
         ('Equipment Aging Report', 'Equipment >80% depreciated', 'assets',
          ARRAY['equipment_records','facilities'],
          '[{"field":"manufacturer","label":"OEM"},{"field":"model","label":"Model"},{"field":"pct_depreciated","label":"% Depreciated"}]'::jsonb,
          true, true),
         ('Recent CON Filings', 'New certificate-of-need filings', 'intelligence',
          ARRAY['con_filings','facilities'],
          '[{"field":"applicant_name","label":"Applicant"},{"field":"equipment_type","label":"Equipment"},{"field":"requested_amount","label":"Amount"}]'::jsonb,
          true, true)
       ON CONFLICT DO NOTHING`,
    );

    console.log("✅ Seed complete");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
