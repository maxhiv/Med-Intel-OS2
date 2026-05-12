/**
 * GoHighLevel adapter. Uses a private integration token + locationId stored
 * in `sub_accounts.crm_credentials`:
 *   { "accessToken": "pit-...", "locationId": "loc_..." }
 *
 * Two-step flow:
 *   1. Upsert the contact in the configured sub-account (location).
 *   2. Create a task on the rep's timeline pointing at the approved draft.
 */
import type { CrmAdapter, CrmPushInput, CrmPushOutcome } from "./types";
import { CrmAdapterError, isRetryableHttpStatus } from "./types";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

interface GhlCredentials {
  accessToken: string;
  locationId: string;
}

function readCreds(raw: unknown): GhlCredentials {
  const c = (raw ?? {}) as Partial<GhlCredentials>;
  if (!c.accessToken || !c.locationId) {
    throw new CrmAdapterError({
      code: "ghl_missing_credentials",
      message: "GoHighLevel sub-account is missing accessToken or locationId",
      retryable: false,
    });
  }
  return { accessToken: c.accessToken, locationId: c.locationId };
}

async function ghlFetch(
  path: string,
  init: RequestInit,
  creds: GhlCredentials,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${GHL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        Version: GHL_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new CrmAdapterError({
      code: "ghl_network_error",
      message: `GHL network error: ${(err as Error).message}`,
      retryable: true,
      details: err,
    });
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new CrmAdapterError({
      code: `ghl_http_${res.status}`,
      message: `GHL ${init.method ?? "GET"} ${path} failed: ${res.status}`,
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

export const ghlAdapter: CrmAdapter = {
  type: "ghl",
  async push({ draft, contact, facility, subAccount }: CrmPushInput): Promise<CrmPushOutcome> {
    const creds = readCreds(subAccount.crmCredentials);

    // Upsert contact: GHL upsert dedupes by email/phone within the location.
    const upsertBody = {
      locationId: creds.locationId,
      firstName: contact.firstName ?? undefined,
      lastName: contact.lastName ?? undefined,
      email: contact.email ?? undefined,
      phone: contact.phone ?? undefined,
      companyName: facility.name,
      website: facility.website ?? undefined,
      address1: facility.address1 ?? undefined,
      city: facility.city ?? undefined,
      state: facility.state ?? undefined,
      postalCode: facility.zip ?? undefined,
      source: "MedIntel OS",
      tags: ["medintel", `signal-score-${facility.signalScore ?? 0}`],
    };
    const upsertRes = (await ghlFetch(
      "/contacts/upsert",
      { method: "POST", body: JSON.stringify(upsertBody) },
      creds,
    )) as { contact?: { id?: string }; id?: string };
    const crmContactId = upsertRes?.contact?.id ?? upsertRes?.id;
    if (!crmContactId) {
      throw new CrmAdapterError({
        code: "ghl_no_contact_id",
        message: "GHL upsert response missing contact id",
        retryable: false,
        details: upsertRes,
      });
    }

    // Create a follow-up task on the contact's timeline. Body excerpt is
    // included so the rep can review without leaving GHL.
    const dueAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const taskTitle = draft.subject?.trim() || `Outreach: ${facility.name}`;
    const taskBody = (draft.body ?? "").slice(0, 4000);
    const taskRes = (await ghlFetch(
      `/contacts/${crmContactId}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          title: taskTitle,
          body: taskBody,
          dueDate: dueAt,
          completed: false,
          assignedTo: subAccount.repUserId ?? undefined,
        }),
      },
      creds,
    )) as { id?: string; task?: { id?: string } };
    const crmDraftId = taskRes?.id ?? taskRes?.task?.id;
    if (!crmDraftId) {
      throw new CrmAdapterError({
        code: "ghl_no_task_id",
        message: "GHL task creation response missing id",
        retryable: false,
        details: taskRes,
      });
    }

    return { crmContactId, crmDraftId, raw: { upsertRes, taskRes } };
  },
};
