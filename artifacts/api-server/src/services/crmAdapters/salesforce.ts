/**
 * Salesforce adapter. Uses an OAuth bearer token + per-org instance URL stored
 * in `sub_accounts.crm_credentials`:
 *   { "accessToken": "00D...", "instanceUrl": "https://acme.my.salesforce.com",
 *     "apiVersion": "v60.0" }
 *
 * Flow:
 *   1. Upsert Contact by Email using the External Id pattern (Email field).
 *   2. Create a Task with WhoId pointing at the contact.
 */
import type { CrmAdapter, CrmPushInput, CrmPushOutcome } from "./types";
import { CrmAdapterError, isRetryableHttpStatus } from "./types";

interface SfCredentials {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
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
  };
}

async function sfFetch(
  path: string,
  init: RequestInit,
  creds: SfCredentials,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${creds.instanceUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const salesforceAdapter: CrmAdapter = {
  type: "salesforce",
  async push({ draft, contact, facility, subAccount }: CrmPushInput): Promise<CrmPushOutcome> {
    const creds = readCreds(subAccount.crmCredentials);
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
    const upsertRes = (await sfFetch(
      upsertPath,
      { method: "PATCH", body: JSON.stringify(fields) },
      creds,
    )) as { id?: string } | null;

    // PATCH upsert returns:
    //   201 Created + { id, created: true }   → new contact, body present
    //   200 OK      + { id, created: false }  → existing contact (some orgs)
    //   204 No Content (no body)              → existing contact (most orgs)
    // For the 204 path we need to look up the contact id via SOQL by email.
    let crmContactId = upsertRes?.id;
    if (!crmContactId) {
      const soql = `SELECT Id FROM Contact WHERE Email = '${contact.email.replace(/'/g, "\\'")}' LIMIT 1`;
      const queryRes = (await sfFetch(
        `/services/data/${creds.apiVersion}/query?q=${encodeURIComponent(soql)}`,
        { method: "GET" },
        creds,
      )) as { records?: Array<{ Id?: string }> };
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
    const taskRes = (await sfFetch(
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
    )) as { id?: string };
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
