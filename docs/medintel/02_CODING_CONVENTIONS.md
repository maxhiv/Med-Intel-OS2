# 02 — Coding Conventions

The rules in `CLAUDE.md` take precedence. This doc fills in the patterns.

---

## Module system

ESM only. `package.json` has `"type": "module"`. Use `import` / `export`, not `require`.

```js
// Good
import { pool } from '../config/database.js';
export class FloridaCONScraper { ... }

// Bad
const pool = require('../config/database');
module.exports = FloridaCONScraper;
```

Note the `.js` extension on imports — required by ESM.

---

## Class skeleton pattern

Every service class follows this pattern. Use it for consistency.

```js
import { pool } from '../../../config/database.js';
import { logger } from '../../../config/logger.js';
import { ClaimRegistry } from '../../confidence/ClaimRegistry.js';

/**
 * Ingests Certificate of Need filings from the Florida AHCA portal.
 *
 * Source: https://apps.ahca.myflorida.com/dm_web/...
 * Cadence: daily at 02:00 ET via cron
 * Output: rows in `capital_triggers` and `intelligence_claims`
 */
export class FloridaCONScraper {
  constructor({ httpClient, claimRegistry, db = pool } = {}) {
    this.http = httpClient;
    this.claims = claimRegistry || new ClaimRegistry({ db });
    this.db = db;
    this.sourceWeight = 0.90; // Florida CON: state filing, attorney-reviewed
  }

  /**
   * Main entry point. Called by cron at 02:00 ET daily.
   * @param {Object} options
   * @param {Date}   options.since - only ingest filings on or after this date
   * @returns {Promise<{ingested: number, skipped: number, errors: number}>}
   */
  async run(options = {}) {
    const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    logger.info('FloridaCONScraper.run started', { since });

    try {
      const filings = await this.fetchFilings(since);
      const result = await this.persistFilings(filings);
      logger.info('FloridaCONScraper.run finished', result);
      return result;
    } catch (err) {
      logger.error('FloridaCONScraper.run failed', { error: err.message, stack: err.stack });
      throw err;
    }
  }

  // private — internal methods
  async fetchFilings(since) { /* TODO */ }
  async persistFilings(filings) { /* TODO */ }
}
```

Every service has:
- A header doc comment with source URL, cadence, and output table
- A constructor that accepts injectable dependencies (for testing)
- A single public entry point (`run()`, `enrich()`, `score()`, etc.)
- Private helpers below

---

## Database access pattern

Use the existing `pool` from `apps/api/src/config/database.js`. For multi-statement work, acquire a client and use transactions.

```js
import { pool } from '../config/database.js';

// Simple query
const { rows } = await pool.query(
  'SELECT * FROM facilities WHERE state = $1 LIMIT $2',
  ['TX', 100]
);

// Transaction
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL app.account_id = $1", [accountId]); // RLS
  await client.query('INSERT INTO opportunities (...) VALUES ($1, $2, ...)', [...]);
  await client.query('UPDATE facility_contacts SET ... WHERE id = $1', [...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

Never string-concatenate SQL. Never run a tenant-scoped query outside a transaction with `SET LOCAL app.account_id`.

---

## HTTP client pattern

Use `undici` (built into Node 20+) for HTTP. Wrap external API calls in a thin client class so they're testable.

```js
import { request } from 'undici';

export class AdzunaClient {
  constructor({ appId, appKey, baseUrl = 'https://api.adzuna.com/v1/api' }) {
    this.appId = appId;
    this.appKey = appKey;
    this.baseUrl = baseUrl;
  }

  async searchJobs({ country = 'us', what, where, results_per_page = 50 }) {
    const url = `${this.baseUrl}/jobs/${country}/search/1?app_id=${this.appId}&app_key=${this.appKey}&what=${encodeURIComponent(what)}&where=${encodeURIComponent(where)}&results_per_page=${results_per_page}`;
    const { statusCode, body } = await request(url);
    if (statusCode !== 200) throw new Error(`Adzuna API error: ${statusCode}`);
    return await body.json();
  }
}
```

Web scraping uses Playwright. Install per-state scrapers under `apps/api/src/services/triggers/con/<State>CONScraper.js`. Use the existing Playwright setup from `package.json` — don't add a second browser library.

---

## Cron / job scheduling

Use the existing job runner in `apps/api/src/workers/`. Register a new job by adding a file there:

```js
// apps/api/src/workers/florida-con-scraper.job.js
import cron from 'node-cron';
import { FloridaCONScraper } from '../services/triggers/con/FloridaCONScraper.js';
import { logger } from '../config/logger.js';

const scraper = new FloridaCONScraper();

// Every day at 02:00 ET
cron.schedule('0 2 * * *', async () => {
  try {
    await scraper.run();
  } catch (err) {
    logger.error('florida-con-scraper.job failed', { error: err.message });
  }
}, { timezone: 'America/New_York' });
```

---

## Confidence scoring integration

When you write a new ingestor, record every claim through `ClaimRegistry`:

```js
import { ClaimRegistry } from '../../confidence/ClaimRegistry.js';

const claims = new ClaimRegistry();
await claims.record({
  entityTable: 'capital_triggers',
  entityId: trigger.id,
  claimField: 'dollar_amount',
  claimValue: String(trigger.dollar_amount),
  sourceType: 'florida_con_filing',
  sourceUrl: trigger.source_url,
  sourceWeight: 0.90,
});
```

The `compute_claim_confidence()` PL/pgSQL function then aggregates this across sources with decay. See `database/migrations/013_confidence_and_validation.sql`.

---

## React conventions (v2.0 frontend work)

- Functional components only. No class components.
- `useState` / `useReducer` for local state, Zustand for cross-page state (existing pattern).
- Tailwind utility classes only — no CSS modules or styled-components.
- Component file = `ComponentName.jsx`. One component per file.
- Default export at the bottom: `export default ComponentName;`
- Use `lucide-react` for icons (already in v1.0).

---

## What not to add

- No new ORMs (no Prisma, Drizzle, TypeORM, Sequelize). Use raw `pg` and the existing pool.
- No new test frameworks. Use `node:test`.
- No TypeScript. Use JSDoc for types if you need annotations.
- No global state singletons except the `pool` and `logger` already in v1.0.
- No new browser libraries beyond Playwright.

---

*See `CLAUDE.md` for the rules · this doc fills in the patterns.*
