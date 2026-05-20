# 03 — Testing Strategy

Use `node:test`, the built-in test runner. No external test framework.

---

## File layout

```
apps/api/tests/
├── fixtures/                  # Static HTML / JSON files used in tests
│   ├── florida-con/
│   │   ├── filing-page-2026-04-15.html
│   │   └── filing-detail-12345.html
│   └── ...
├── triggers/
│   ├── FloridaCONScraper.test.js
│   ├── EMMABondIngestor.test.js
│   └── ...
├── equipment_age/
└── confidence/
```

Mirror the `src/` directory structure under `tests/`.

---

## Pattern

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FloridaCONScraper } from '../../src/services/triggers/con/FloridaCONScraper.js';
import { readFileSync } from 'node:fs';

describe('FloridaCONScraper', () => {
  test('parses a single filing correctly', () => {
    const fixture = readFileSync('./tests/fixtures/florida-con/filing-detail-12345.html', 'utf8');
    const scraper = new FloridaCONScraper({ httpClient: null });
    const filing = scraper.parseFiling(fixture);

    assert.equal(filing.state, 'FL');
    assert.equal(filing.equipmentType, 'CT scanner');
    assert.equal(filing.approvedAmount, 2_400_000);
    assert.match(filing.filingUrl, /^https:\/\/apps\.ahca\.myflorida\.com/);
  });

  test('throws on malformed HTML', () => {
    const scraper = new FloridaCONScraper({ httpClient: null });
    assert.throws(
      () => scraper.parseFiling('<html>nope</html>'),
      /missing filing date/i
    );
  });

  test('ignores filings older than the since date', async () => {
    const scraper = new FloridaCONScraper({
      httpClient: stubHttpClient('./tests/fixtures/florida-con/filing-page-2026-04-15.html'),
    });
    const filings = await scraper.fetchFilings(new Date('2026-04-20'));
    assert.equal(filings.length, 0);
  });
});

function stubHttpClient(fixturePath) {
  return {
    async fetch() {
      return {
        status: 200,
        text: async () => readFileSync(fixturePath, 'utf8'),
      };
    },
  };
}
```

---

## Test categories

For every public method, write at minimum:

1. **Happy path** — typical input produces typical output
2. **Error path** — bad input produces a descriptive error
3. **Edge case** — empty input, boundary values, malformed data

For scrapers specifically:

4. **Fixture parsing** — snapshot a real page once, parse it, assert structure
5. **Date filtering** — `since` cutoff works as expected
6. **Idempotency** — running the scraper twice doesn't double-insert

For confidence scoring:

7. **Single source** — claim is `provisional`
8. **Two agreeing sources** — claim is `verified`
9. **Contradictory sources** — contradiction is detected
10. **Decay** — old claim loses confidence over time

---

## What tests must NOT do

- **Never hit live URLs.** Use fixture files. The CI environment has no network.
- **Never depend on a live database for unit tests.** Use stub DB clients.
- **Never assert against current dates.** Inject the clock as a dependency or use freeze patterns.
- **Never test private methods directly.** Test through the public entry point.

---

## Integration tests (the small set)

A few tests do need a real Postgres connection. Put these under `apps/api/tests/integration/` and gate them with an env var:

```js
import { test } from 'node:test';

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true';

test('inserting a capital_trigger triggers the confidence recompute', { skip: !RUN_INTEGRATION }, async () => {
  // ...
});
```

Run with `RUN_INTEGRATION=true npm test`. CI runs them separately from unit tests.

---

## Running tests

```bash
# Unit tests only (default, fast)
npm test

# With coverage
npm run test:coverage

# Integration tests (requires Postgres dev DB)
RUN_INTEGRATION=true npm test

# Single file
node --test apps/api/tests/triggers/FloridaCONScraper.test.js
```

---

## Coverage targets

- Per service file: 80%+ line coverage
- Confidence layer: 95%+ (it's the moat — overtest it)
- Scrapers: 70%+ (page parsing is fragile by nature; cover the structure)
- Vertical orchestrators: 80%+

These are not enforced as hard gates, but the user will ask "what's the coverage on the confidence scorer" before shipping v2.0.

---

*node:test docs: https://nodejs.org/api/test.html*
