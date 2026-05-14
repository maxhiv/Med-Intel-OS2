-- Idempotent backfill: link every existing facility to every existing account.
-- Uses ON CONFLICT DO NOTHING so re-running this is always safe.
-- Intended to be run once after a bulk NPI import, or via the admin endpoint
-- POST /admin/facilities/link-all which executes the same logic at runtime.

INSERT INTO account_facilities (account_id, facility_id)
SELECT a.id, f.id
FROM accounts a
CROSS JOIN facilities f
ON CONFLICT (account_id, facility_id) DO NOTHING;
