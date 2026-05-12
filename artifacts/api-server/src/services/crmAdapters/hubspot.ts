/**
 * HubSpot adapter. Uses a private app access token stored in
 * `sub_accounts.crm_credentials`:
 *   { "accessToken": "pat-na1-..." }
 * Optional: { "ownerId": "12345678" } — assigns the task to that HubSpot user.
 *
 * Flow:
 *   1. Upsert contact by email (search → create or patch).
 *   2. Create a TASK engagement and associate it with the contact.
 */
import type { CrmAdapter, CrmPushInput, CrmPushOutcome } from "./types";
import { CrmAdapterError, isRetryableHttpStatus } from "./types";

const HUBSPOT_BASE = "https://api.hubapi.com";

interface HubspotCredentials {
  accessToken: string;
  ownerId?: string;
}

function readCreds(raw: unknown): HubspotCredentials {
  const c = (raw ?? {}) as Partial<HubspotCredentials>;
  if (!c.accessToken) {
    throw new CrmAdapterError({
      code: "hubspot_missing_credentials",
      message: "HubSpot sub-account is missing accessToken",
      retryable: false,
    });
  }
  return { accessToken: c.accessToken, ownerId: c.ownerId };
}

async function hsFetch(
  path: string,
  init: RequestInit,
  creds: HubspotCredentials,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${HUBSPOT_BASE}${path}`, {
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
      code: "hubspot_network_error",
      message: `HubSpot network error: ${(err as Error).message}`,
      retryable: true,
      details: err,
    });
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new CrmAdapterError({
      code: `hubspot_http_${res.status}`,
      message: `HubSpot ${init.method ?? "GET"} ${path} failed: ${res.status}`,
      retryable: isRetryableHttpStatus(res.status),
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

export const hubspotAdapter: CrmAdapter = {
  type: "hubspot",
  async push({ draft, contact, facility, subAccount }: CrmPushInput): Promise<CrmPushOutcome> {
    const creds = readCreds(subAccount.crmCredentials);
    if (!contact.email) {
      throw new CrmAdapterError({
        code: "hubspot_contact_missing_email",
        message: "HubSpot upsert requires an email address",
        retryable: false,
      });
    }

    const properties: Record<string, string> = {
      email: contact.email,
      firstname: contact.firstName ?? "",
      lastname: contact.lastName ?? "",
      jobtitle: contact.title ?? "",
      phone: contact.phone ?? "",
      company: facility.name,
      website: facility.website ?? "",
      city: facility.city ?? "",
      state: facility.state ?? "",
      zip: facility.zip ?? "",
    };

    // Search by email so we don't create duplicates.
    const search = (await hsFetch(
      "/crm/v3/objects/contacts/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: "email", operator: "EQ", value: contact.email },
              ],
            },
          ],
          properties: ["email"],
          limit: 1,
        }),
      },
      creds,
    )) as { results?: Array<{ id: string }> };

    let crmContactId: string;
    const existing = search.results?.[0]?.id;
    if (existing) {
      await hsFetch(
        `/crm/v3/objects/contacts/${existing}`,
        { method: "PATCH", body: JSON.stringify({ properties }) },
        creds,
      );
      crmContactId = existing;
    } else {
      const created = (await hsFetch(
        "/crm/v3/objects/contacts",
        { method: "POST", body: JSON.stringify({ properties }) },
        creds,
      )) as { id?: string };
      if (!created.id) {
        throw new CrmAdapterError({
          code: "hubspot_no_contact_id",
          message: "HubSpot contact create response missing id",
          retryable: false,
          details: created,
        });
      }
      crmContactId = created.id;
    }

    // Create a TASK engagement and associate to the contact.
    const dueTs = Date.now() + 24 * 3600 * 1000;
    const taskTitle = draft.subject?.trim() || `Outreach: ${facility.name}`;
    const taskBody = (draft.body ?? "").slice(0, 65000);
    const task = (await hsFetch(
      "/crm/v3/objects/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          properties: {
            hs_task_subject: taskTitle,
            hs_task_body: taskBody,
            hs_task_status: "NOT_STARTED",
            hs_task_priority: "MEDIUM",
            hs_task_type: draft.channel === "phone" ? "CALL" : "EMAIL",
            hs_timestamp: String(dueTs),
            ...(creds.ownerId ? { hubspot_owner_id: creds.ownerId } : {}),
          },
          associations: [
            {
              to: { id: crmContactId },
              // 204 = task → contact association type id
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: 204,
                },
              ],
            },
          ],
        }),
      },
      creds,
    )) as { id?: string };
    if (!task.id) {
      throw new CrmAdapterError({
        code: "hubspot_no_task_id",
        message: "HubSpot task create response missing id",
        retryable: false,
        details: task,
      });
    }

    return { crmContactId, crmDraftId: task.id };
  },
};
