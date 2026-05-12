/**
 * ZeroBounce email validation adapter.
 *
 * Real HTTP calls to https://api.zerobounce.net/v2/validate. Per-call billed
 * cost is recorded by the caller in micros. We expose a thin wrapper that:
 *   - retries transient (5xx / network) failures with exponential backoff
 *   - reports a normalised result + a confidence delta
 *
 * Pricing (May 2026): credits sold in bulk; a single validation costs roughly
 * $0.008. We hard-code that as the recorded micros so spend telemetry is
 * directionally correct even before per-account billing reconciliation.
 */
import { logger } from "../../lib/logger";

export const ZEROBOUNCE_COST_MICROS = 8_000;
const ENDPOINT = "https://api.zerobounce.net/v2/validate";

export type ZbStatus =
  | "valid"
  | "invalid"
  | "catch-all"
  | "unknown"
  | "spamtrap"
  | "abuse"
  | "do_not_mail";

export interface ZbResponse {
  address?: string;
  status?: ZbStatus;
  sub_status?: string;
  account?: string;
  domain?: string;
  did_you_mean?: string | null;
  free_email?: boolean;
  mx_found?: boolean;
  smtp_provider?: string;
  error?: string;
}

export interface ZbResult {
  ok: boolean;
  status: ZbStatus | "error";
  confidenceDelta: number;
  attempts: number;
  raw: ZbResponse | { error: string };
}

const CONFIDENCE_BY_STATUS: Record<ZbStatus, number> = {
  valid: 25,
  "catch-all": 5,
  unknown: 0,
  invalid: -40,
  spamtrap: -50,
  abuse: -50,
  do_not_mail: -50,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function validateEmail(
  email: string,
  opts: { apiKey: string; maxAttempts?: number; signal?: AbortSignal } = {
    apiKey: "",
  },
): Promise<ZbResult> {
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 5));
  const url = `${ENDPOINT}?api_key=${encodeURIComponent(opts.apiKey)}&email=${encodeURIComponent(email)}`;

  let attempts = 0;
  let lastErr: unknown = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const res = await fetch(url, {
        signal: opts.signal,
        headers: { Accept: "application/json" },
      });
      // 4xx (other than 429) is permanent — no point retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = (await res.json().catch(() => ({}))) as ZbResponse;
        return {
          ok: false,
          status: "error",
          confidenceDelta: 0,
          attempts,
          raw: { ...body, error: body.error ?? `http_${res.status}` },
        };
      }
      if (!res.ok) throw new Error(`http_${res.status}`);

      const json = (await res.json()) as ZbResponse;
      const status = (json.status ?? "unknown") as ZbStatus;
      const delta = CONFIDENCE_BY_STATUS[status] ?? 0;
      return {
        ok: status === "valid" || status === "catch-all",
        status,
        confidenceDelta: delta,
        attempts,
        raw: json,
      };
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt: attempts, err: (err as Error).message, email },
        "zerobounce attempt failed",
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
