/**
 * Bouncer (usebouncer.com) email validation adapter.
 *
 * Acts as a backup / fallback to ZeroBounce. Same shape as the ZeroBounce
 * adapter so the enrichment pipeline can treat them interchangeably:
 *   - retries transient (5xx / network) failures with exponential backoff
 *   - returns a normalised result with a confidence delta
 *
 * Pricing (May 2026): bulk credits land around $0.007 per single verification.
 * We hard-code that as the recorded micros so spend telemetry is directionally
 * correct prior to per-account billing reconciliation.
 *
 * API reference: https://docs.usebouncer.com/reference/email-verification
 *   GET https://api.usebouncer.com/v1.1/email/verify?email=...
 *   Header: x-api-key: <key>
 *   Response: { email, status, reason, domain, account, ... }
 */
import { logger } from "../../lib/logger";

export const BOUNCER_COST_MICROS = 7_000;
const ENDPOINT = "https://api.usebouncer.com/v1.1/email/verify";

export type BouncerStatus =
  | "deliverable"
  | "undeliverable"
  | "risky"
  | "unknown";

export interface BouncerResponse {
  email?: string;
  status?: BouncerStatus;
  reason?: string;
  domain?: {
    name?: string;
    acceptAll?: string;
    disposable?: string;
    free?: string;
  };
  account?: { role?: string; disposable?: string; full?: string };
  dns?: { type?: string; record?: string };
  provider?: string;
  error?: string;
  message?: string;
}

export interface BouncerResult {
  ok: boolean;
  status: BouncerStatus | "error";
  confidenceDelta: number;
  attempts: number;
  raw: BouncerResponse | { error: string };
}

const CONFIDENCE_BY_STATUS: Record<BouncerStatus, number> = {
  deliverable: 25,
  risky: 5,
  unknown: 0,
  undeliverable: -40,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function validateEmail(
  email: string,
  opts: { apiKey: string; maxAttempts?: number; signal?: AbortSignal } = {
    apiKey: "",
  },
): Promise<BouncerResult> {
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 5));
  const url = `${ENDPOINT}?email=${encodeURIComponent(email)}`;

  let attempts = 0;
  let lastErr: unknown = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const res = await fetch(url, {
        signal: opts.signal,
        headers: {
          Accept: "application/json",
          "x-api-key": opts.apiKey,
        },
      });
      // 4xx (other than 429) is permanent — no point retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = (await res.json().catch(() => ({}))) as BouncerResponse;
        return {
          ok: false,
          status: "error",
          confidenceDelta: 0,
          attempts,
          raw: {
            ...body,
            error: body.error ?? body.message ?? `http_${res.status}`,
          },
        };
      }
      if (!res.ok) throw new Error(`http_${res.status}`);

      const json = (await res.json()) as BouncerResponse;
      const status = (json.status ?? "unknown") as BouncerStatus;
      const delta = CONFIDENCE_BY_STATUS[status] ?? 0;
      return {
        ok: status === "deliverable" || status === "risky",
        status,
        confidenceDelta: delta,
        attempts,
        raw: json,
      };
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt: attempts, err: (err as Error).message, email },
        "bouncer attempt failed",
      );
      if (attempts < maxAttempts) {
        // Exponential backoff: 250ms, 500ms, 1000ms…
        await sleep(250 * 2 ** (attempts - 1));
      }
    }
  }

  return {
    ok: false,
    status: "error",
    confidenceDelta: 0,
    attempts,
    raw: { error: (lastErr as Error)?.message ?? "unknown_error" },
  };
}
