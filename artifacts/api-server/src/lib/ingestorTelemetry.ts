/**
 * In-process telemetry for ingestor runs.
 * Values survive for the lifetime of the current process; cleared on restart.
 * Exposed via GET /health so operators can see the last run time without
 * needing to tail logs.
 */

export interface IngestorTelemetry {
  lastRun: string | null;
  lastDurationMs: number | null;
  lastStatus: "success" | "error" | null;
}

const store = new Map<string, IngestorTelemetry>();

export function recordIngestorRun(
  key: string,
  durationMs: number,
  status: "success" | "error",
): void {
  store.set(key, {
    lastRun: new Date().toISOString(),
    lastDurationMs: durationMs,
    lastStatus: status,
  });
}

export function getIngestorTelemetry(key: string): IngestorTelemetry {
  return store.get(key) ?? { lastRun: null, lastDurationMs: null, lastStatus: null };
}

export function getAllIngestorTelemetry(): Record<string, IngestorTelemetry> {
  const out: Record<string, IngestorTelemetry> = {};
  for (const [k, v] of store.entries()) {
    out[k] = v;
  }
  return out;
}
