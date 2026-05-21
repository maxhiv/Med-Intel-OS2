-- v2a_seed_paid_sources.sql — default-disabled paid-source rows + usage limits.
--
-- Adapted from handoff seed 05. Targets the v2.0 `paid_source_approvals`
-- table (NOT the v1.0 global `enrichment_source_approvals`). One row per
-- (account × source), approved=false. Both this row AND the matching
-- `*_ENABLED` env var must be true for a source to be callable.
--
-- Idempotent: ON CONFLICT DO NOTHING. Re-run after adding accounts to
-- backfill rows for the new tenants.

WITH paid_source_catalog (source_name, source_category, source_tier, estimated_monthly_cost_usd, notes) AS (
  VALUES
    ('anthropic_claude_sonnet_4', 'anthropic_agent',      'paid',        500.00,
     'Claude Sonnet API powering ProspectingAgent. Cost scales with usage.'),
    ('openrouteservice',          'open_informatics_mcp', 'paid',         50.00,
     'ORS drive-time isochrones. Free tier 2K req/day; $50/mo above.'),
    ('osrm_self_hosted',          'open_informatics_mcp', 'self_hosted',   0.00,
     'Self-hosted OSRM routing. No API cost, operational cost only.'),
    ('google_custom_search',      'open_informatics_mcp', 'paid',         25.00,
     'Google CSE for web-intelligence. 100 req/day free, $5/1K above.'),
    ('proxycurl',                 'open_informatics_mcp', 'paid',        299.00,
     'LinkedIn enrichment via web-intelligence. $299+/mo.'),
    ('chpl_api',                  'open_informatics_mcp', 'paid',          0.00,
     'ONC CHPL API for EHR enrichment. Free but rate-limited; needs key.'),
    ('newsapi',                   'open_informatics_mcp', 'paid',        449.00,
     'NewsAPI press-release monitoring. Free 100/day, $449/mo business.'),
    ('adzuna',                    'medintel_proprietary', 'paid',          0.00,
     'Adzuna job postings. Free tier 1K req/day.'),
    ('jooble',                    'medintel_proprietary', 'paid',          0.00,
     'Jooble job postings. Free 500/day.'),
    ('usajobs',                   'medintel_proprietary', 'paid',          0.00,
     'USAJobs API. Free; needs email + key registration.'),
    ('outscraper',                'medintel_proprietary', 'paid',        500.00,
     'Outscraper aggregated contact enrichment. Pay-per-call.'),
    ('searchatlas',               'medintel_proprietary', 'paid',        299.00,
     'Search Atlas AEO/GEO white-label SEO outputs.'),
    ('doximity',                  'medintel_proprietary', 'paid',        500.00,
     'Doximity physician enrichment (v1.0 carryover).'),
    ('docgraph_caresets',         'medintel_proprietary', 'licensed',      0.00,
     'DocGraph shared-patient dataset. One-time license, file-imported.')
)
INSERT INTO paid_source_approvals (
  account_id, source_name, source_category, source_tier,
  approved, estimated_monthly_cost_usd, notes, approval_changed_at
)
SELECT a.id, p.source_name, p.source_category, p.source_tier,
       FALSE, p.estimated_monthly_cost_usd, p.notes, NOW()
  FROM accounts a
  CROSS JOIN paid_source_catalog p
ON CONFLICT (account_id, source_name) DO NOTHING;

-- Default usage limits for any account that lacks a row.
INSERT INTO agent_usage_limits (account_id)
SELECT id FROM accounts
ON CONFLICT (account_id) DO NOTHING;
