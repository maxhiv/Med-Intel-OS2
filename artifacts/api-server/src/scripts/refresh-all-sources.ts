/**
 * One-shot script: trigger every live ingestor via the consolidated
 * POST /api/signals/ingest/all endpoint and print a per-source results table.
 *
 * Auth: sends X-Internal-Admin-Key matching the INTERNAL_ADMIN_KEY secret.
 * Set that secret in the Replit Secrets panel before running.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/refresh-all-sources.ts
 */

export {};

const internalKey = process.env.INTERNAL_ADMIN_KEY;
if (!internalKey) {
  console.error(
    "ERROR: INTERNAL_ADMIN_KEY secret is not set.\n" +
    "Add it in the Replit Secrets panel, then restart the server and re-run.",
  );
  process.exit(1);
}

const port = process.env.PORT ?? "8080";
const url  = `http://localhost:${port}/api/signals/ingest/all`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceResult {
  status: "ok" | "error";
  signalsInserted: number;
  errors: number;
  errorMsg?: string;
  durationMs: number;
}

// ─── Call the orchestration endpoint ─────────────────────────────────────────

console.log("\n🔄  MedIntel OS — Refreshing all live data sources\n");
console.log(`   POST ${url}\n`);

const wallStart = Date.now();

let results: Record<string, SourceResult>;
try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-admin-key": internalKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    process.exit(1);
  }

  results = await res.json() as Record<string, SourceResult>;
} catch (err) {
  console.error(`Failed to reach API server: ${String(err)}`);
  process.exit(1);
}

// ─── Print results table ──────────────────────────────────────────────────────

const entries = Object.entries(results);
const ok      = entries.filter(([, r]) => r.status === "ok");
const failed  = entries.filter(([, r]) => r.status === "error");
const totalSignals = entries.reduce((n, [, r]) => n + (r.signalsInserted ?? 0), 0);

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const [name, r] of entries) {
  const icon    = r.status === "ok" ? "✅" : "❌";
  const ms      = `(${(r.durationMs / 1000).toFixed(1)}s)`;
  const sigs    = r.signalsInserted > 0 ? `  +${r.signalsInserted} signals` : "";
  const errs    = r.errors > 0 ? `  ⚠ ${r.errors} error(s)` : "";
  const errMsg  = r.errorMsg ? `  — ${r.errorMsg}` : "";
  console.log(`${icon}  ${name}${sigs}${errs}${errMsg}  ${ms}`);
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${ok.length}/${entries.length} sources succeeded`);
console.log(`  ~${totalSignals} total new signals inserted`);
if (failed.length > 0) {
  console.log(`  Failed: ${failed.map(([n]) => n).join(", ")}`);
}
console.log(`  Total elapsed: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

process.exit(failed.length > 0 ? 1 : 0);
