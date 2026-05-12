/**
 * Common interface implemented by every CRM adapter (GoHighLevel, HubSpot,
 * Salesforce, …). The batch runner and per-draft push path call adapters
 * through this surface so the rest of the app stays CRM-agnostic.
 *
 * Adapters MUST:
 *   - Throw a `CrmAdapterError` with a `code` on failure (transport, auth,
 *     validation). The runner inspects `retryable` to decide whether to retry.
 *   - Be idempotent on contact upsert: re-running with the same email should
 *     return the existing CRM contact id, not create a duplicate.
 */
import type { Contact, Facility, OutreachDraft, SubAccount } from "@workspace/db";

export type CrmType = "ghl" | "hubspot" | "salesforce";

export interface CrmPushInput {
  draft: OutreachDraft;
  contact: Contact;
  facility: Facility;
  subAccount: SubAccount;
}

export interface CrmPushOutcome {
  crmContactId: string;
  crmDraftId: string;
  crmCompanyId?: string | null;
  raw?: unknown;
}

export interface CrmTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Shape of the credential editor surfaced through the admin API.
 * `secret: true` fields are masked in GET responses (only the last 4
 * characters are returned). Non-secret fields are returned in clear.
 */
export interface CredentialFieldSpec {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface CrmAdapter {
  readonly type: CrmType;
  /** Field schema rendered by the admin UI for this CRM. */
  readonly credentialSchema: CredentialFieldSpec[];
  push(input: CrmPushInput): Promise<CrmPushOutcome>;
  /**
   * Hit a no-op endpoint on the CRM to confirm credentials are valid.
   * Receives ALREADY-DECRYPTED credentials.
   */
  testConnection(credentials: Record<string, unknown>): Promise<CrmTestResult>;
}

export class CrmAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: unknown;
  constructor(opts: {
    code: string;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = "CrmAdapterError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.details = opts.details;
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  // 408 timeout, 425 too early, 429 rate limit, 5xx server errors.
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
