/**
 * Salesforce adapter. Uses an OAuth bearer token + per-org instance URL stored
 * in `sub_accounts.crm_credentials`:
 *   {
 *     "accessToken":  "00D...",          // current bearer
 *     "instanceUrl":  "https://acme.my.salesforce.com",
 *     "apiVersion":   "v60.0",
 *     "refreshToken": "5Aep...",         // optional, enables auto-refresh
 *     "clientId":     "3MVG...",         // connected-app consumer key
 *     "clientSecret": "...",             // connected-app consumer secret
 *     "loginUrl":     "https://login.salesforce.com" // optional, defaults to prod
 *   }
 *
 * When a refresh_token + client credentials are present, a 401 response
 * triggers a one-shot token refresh and a single retry. The refreshed
 * access token is persisted back to `sub_accounts.crm_credentials` (still
 * encrypted at rest) so the rest of the system picks it up.
 */
import { eq } from "drizzle-orm";
import type {
  CrmAdapter,
  CrmPushInput,
  CrmPushOutcome,
  CrmTestResult,
  CredentialFieldSpec,
} from "./types";
import { CrmAdapterError, isRetryableHttpStatus } from "./types";
import { db, subAccounts } from "@workspace/db";
import { decodeStoredCredentials, encryptJson } from "../encryption";
import { logger } from "../../lib/logger";

interface SfCredentials {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  loginUrl?: string;
}

function readCreds(raw: unknown): SfCredentials {
  const c = (raw ?? {}) as Partial<SfCredentials>;
  if (!c.accessToken || !c.instanceUrl) {
    throw new CrmAdapterError({
      code: "salesforce_missing_credentials",
      message: "Salesforce sub-account is missing accessToken or instanceUrl",
      retryable: false,
    });
  }
  return {
    accessToken: c.accessToken,
    instanceUrl: c.instanceUrl.replace(/\/+$/, ""),
    apiVersion: c.apiVersion ?? "v60.0",
    refreshToken: c.refreshToken,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    loginUrl: c.loginUrl,
  };
}

function canRefresh(c: SfCredentials): boolean {
  return Boolean(c.refreshToken && c.clientId && c.clientSecret);
}

/**
 * Exchange a refresh_token for a fresh access_token. Returns the new
 * access token and (possibly updated) instance URL.
 */
async function refreshAccessToken(
  c: SfCredentials,
): Promise<{ accessToken: string; instanceUrl: string }> {
  if (!canRefresh(c)) {
    throw new CrmAdapterError({
      code: "salesforce_refresh_unavailable",
      message: "Salesforce refresh requires refreshToken + clientId + clientSecret",
      retryable: false,
    });
  }
  const base = (c.loginUrl ?? "https://login.salesforce.com").replace(/\/+$/, "");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: c.clientId!,
    client_secret: c.clientSecret!,
    refresh_token: c.refreshToken!,
  });
  let res: Response;
  try {
    res = await fetch(`${base}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (err) {
    throw new CrmAdapterError({
      code: "salesforce_refresh_network_error",
      message: `Salesforce token refresh network error: ${(err as Error).message}`,
      retryable: true,
    });
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new CrmAdapterError({
      code: `salesforce_refresh_http_${res.status}`,
      message: `Salesforce token refresh failed: ${res.status}`,
      retryable: false,
      status: res.status,
      details: body ?? text,
    });
  }
  const parsed = (body ?? {}) as {
    access_token?: string;
    instance_url?: string;
  };
  if (!parsed.access_token) {
    throw new CrmAdapterError({
      code: "salesforce_refresh_no_token",
      message: "Salesforce refresh response missing access_token",
      retryable: false,
      details: parsed,
    });
  }
  return {
    accessToken: parsed.access_token,
    instanceUrl: (parsed.instance_url ?? c.instanceUrl).replace(/\/+$/, ""),
  };
}

/**
 * Persist a refreshed access token back to the sub_account row, keeping
 * the at-rest encryption envelope intact.
 */
async function persistRefreshedToken(
  subAccountId: string,
  oldCreds: SfCredentials,
  next: { accessToken: string; instanceUrl: string },
): Promise<void> {
  const merged = {
    ...oldCreds,
    accessToken: next.accessToken,
    instanceUrl: next.instanceUrl,
  };
  await db
    .update(subAccounts)
    .set({ crmCredentials: encryptJson(merged), updatedAt: new Date() })
    .where(eq(subAccounts.id, subAccountId));
}

async function sfRawFetch(
  path: string,
  init: RequestInit,
  creds: SfCredentials,
): Promise<Response> {
  return fetch(`${creds.instanceUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function sfFetch(
  path: string,
  init: RequestInit,
  creds: SfCredentials,
): Promise<unknown> {
  let res: Response;
  try {
    res = await sfRawFetch(path, init, creds);
  } catch (err) {
    throw new CrmAdapterError({
      code: "salesforce_network_error",
      message: `Salesforce network error: ${(err as Error).message}`,
      retryable: true,
      details: err,
    });
  }
  // Salesforce returns 204 No Content on PATCH-upsert when the record already
  // exists (update path) — body is empty, but the call succeeded.
  const text = res.status === 204 ? "" : await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new CrmAdapterError({
      code: `salesforce_http_${res.status}`,
      message: `Salesforce ${init.method ?? "GET"} ${path} failed: ${res.status}`,
      // 401 from Salesforce typically means the bearer token expired —
      // surface as retryable so the runner reschedules after a refresh job.
      retryable: res.status === 401 || isRetryableHttpStatus(res.status),
      status: res.status,
      details: body ?? text,
    });
  }
  return body;
}

/**
 * sfFetch + auto-refresh-on-401. Used by `push` so a transient expired
 * token doesn't fail the batch. The refreshed token is persisted back to
 * the sub-account row so subsequent calls in the same process pick it up.
 */
async function sfFetchWithRefresh(
  path: string,
  init: RequestInit,
  creds: SfCredentials,
  subAccountId: string,
): Promise<{ body: unknown; creds: SfCredentials }> {
  try {
    const body = await sfFetch(path, init, creds);
    return { body, creds };
  } catch (err) {
    const e = err as CrmAdapterError;
    if (e.status === 401 && canRefresh(creds)) {
      logger.info({ subAccountId }, "Salesforce 401: refreshing access token");
      const next = await refreshAccessToken(creds);
      const newCreds: SfCredentials = {
        ...creds,
        accessToken: next.accessToken,
        instanceUrl: next.instanceUrl,
      };
      await persistRefreshedToken(subAccountId, creds, next);
      const body = await sfFetch(path, init, newCreds);
      return { body, creds: newCreds };
    }
    throw err;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const salesforceCredentialSchema: CredentialFieldSpec[] = [
  {
    key: "accessToken",
    label: "Access Token",
    required: true,
    secret: true,
    placeholder: "00D...",
  },
  {
    key: "instanceUrl",
    label: "Instance URL",
    required: true,
    secret: false,
    placeholder: "https://acme.my.salesforce.com",
  },
  {
    key: "apiVersion",
    label: "API Version",
    required: false,
    secret: false,
    placeholder: "v60.0",
  },
  {
    key: "refreshToken",
    label: "Refresh Token",
    required: false,
    secret: true,
    helpText: "Required to auto-refresh expired access tokens.",
  },
  {
    key: "clientId",
    label: "Connected App Consumer Key",
    required: false,
    secret: false,
    helpText: "Required for refresh.",
  },
  {
    key: "clientSecret",
    label: "Connected App Consumer Secret",
    required: false,
    secret: true,
    helpText: "Required for refresh.",
  },
  {
    key: "loginUrl",
    label: "Login URL",
    required: false,
    secret: false,
    placeholder: "https://login.salesforce.com",
    helpText: "Override for sandbox / My Domain logins.",
  },
];

export const salesforceAdapter: CrmAdapter = {
  type: "salesforce",
  credentialSchema: salesforceCredentialSchema,
  async testConnection(credentials): Promise<CrmTestResult> {
    let creds: SfCredentials;
    try {
      creds = readCreds(credentials);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const probe = async (c: SfCredentials): Promise<unknown> =>
      sfFetch(`/services/data/${c.apiVersion}/limits`, { method: "GET" }, c);
    try {
      const body = await probe(creds);
      return {
        ok: true,
        message: `Connected to Salesforce at ${creds.instanceUrl}`,
        details: { limits: summarizeLimits(body) },
      };
    } catch (err) {
      const e = err as CrmAdapterError;
      // If we have refresh material, try once after a refresh.
      if (e.status === 401 && canRefresh(creds)) {
        try {
          const next = await refreshAccessToken(creds);
          const refreshed: SfCredentials = {
            ...creds,
            accessToken: next.accessToken,
            instanceUrl: next.instanceUrl,
          };
          const body = await probe(refreshed);
          return {
            ok: true,
            message: `Connected to Salesforce after token refresh (${refreshed.instanceUrl})`,
            details: {
              refreshed: true,
              limits: summarizeLimits(body),
            },
          };
        } catch (refreshErr) {
          const re = refreshErr as CrmAdapterError;
          return {
            ok: false,
            message: re.message,
            details: { code: re.code, status: re.status ?? null },
          };
        }
      }
      return {
        ok: false,
        message: e.message,
        details: { code: e.code, status: e.status ?? null },
      };
    }
  },
  async push({ draft, contact, facility, subAccount }: CrmPushInput): Promise<CrmPushOutcome> {
    let creds = readCreds(decodeStoredCredentials(subAccount.crmCredentials));
    if (!contact.email) {
      throw new CrmAdapterError({
        code: "salesforce_contact_missing_email",
        message: "Salesforce upsert requires an email address",
        retryable: false,
      });
    }

    // Upsert by external id (Email). Returns 200 (updated) or 201 (created)
    // with { id, created }.
    const fields = {
      FirstName: contact.firstName ?? "",
      LastName: contact.lastName || contact.firstName || "Unknown",
      Email: contact.email,
      Title: contact.title ?? null,
      Phone: contact.phone ?? null,
      MailingCity: facility.city ?? null,
      MailingState: facility.state ?? null,
      MailingPostalCode: facility.zip ?? null,
    };
    const upsertPath = `/services/data/${creds.apiVersion}/sobjects/Contact/Email/${encodeURIComponent(contact.email)}`;
    const upsertCall = await sfFetchWithRefresh(
      upsertPath,
      { method: "PATCH", body: JSON.stringify(fields) },
      creds,
      subAccount.id,
    );
    creds = upsertCall.creds;
    const upsertRes = upsertCall.body as { id?: string } | null;

    // PATCH upsert returns:
    //   201 Created + { id, created: true }   → new contact, body present
    //   200 OK      + { id, created: false }  → existing contact (some orgs)
    //   204 No Content (no body)              → existing contact (most orgs)
    // For the 204 path we need to look up the contact id via SOQL by email.
    let crmContactId = upsertRes?.id;
    if (!crmContactId) {
      const soql = `SELECT Id FROM Contact WHERE Email = '${contact.email.replace(/'/g, "\\'")}' LIMIT 1`;
      const queryCall = await sfFetchWithRefresh(
        `/services/data/${creds.apiVersion}/query?q=${encodeURIComponent(soql)}`,
        { method: "GET" },
        creds,
        subAccount.id,
      );
      creds = queryCall.creds;
      const queryRes = queryCall.body as { records?: Array<{ Id?: string }> };
      crmContactId = queryRes?.records?.[0]?.Id;
    }
    if (!crmContactId) {
      throw new CrmAdapterError({
        code: "salesforce_no_contact_id",
        message: "Salesforce contact upsert succeeded but contact id could not be resolved",
        retryable: false,
        details: upsertRes,
      });
    }

    const dueDate = new Date(Date.now() + 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const taskTitle = (draft.subject?.trim() || `Outreach: ${facility.name}`).slice(0, 255);
    const taskCall = await sfFetchWithRefresh(
      `/services/data/${creds.apiVersion}/sobjects/Task`,
      {
        method: "POST",
        body: JSON.stringify({
          Subject: taskTitle,
          Description: (draft.body ?? "").slice(0, 32000),
          Status: "Not Started",
          Priority: "Normal",
          ActivityDate: dueDate,
          WhoId: crmContactId,
          OwnerId: subAccount.repUserId ?? undefined,
        }),
      },
      creds,
      subAccount.id,
    );
    const taskRes = taskCall.body as { id?: string };
    if (!taskRes?.id) {
      throw new CrmAdapterError({
        code: "salesforce_no_task_id",
        message: "Salesforce task create response missing id",
        retryable: false,
        details: taskRes,
      });
    }

    return { crmContactId, crmDraftId: taskRes.id };
  },
};

function summarizeLimits(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, { Max?: number; Remaining?: number }>;
  const api = b.DailyApiRequests;
  return api
    ? { dailyApiMax: api.Max ?? null, dailyApiRemaining: api.Remaining ?? null }
    : {};
}
