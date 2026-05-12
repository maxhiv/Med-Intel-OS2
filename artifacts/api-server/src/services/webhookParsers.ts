/**
 * Per-CRM webhook signature verifiers and event normalizers.
 *
 * Each CRM (GoHighLevel, HubSpot, Salesforce) posts engagement events to
 * `/api/webhooks/{crm}/{subAccountId}`. The shared secret used to sign the
 * payload lives at `sub_accounts.crm_credentials.webhookSecret`.
 *
 * The signature schemes were chosen to match each vendor's documented format
 * for private/custom integrations:
 *   - GHL:        x-wh-signature              = hex HMAC-SHA256(secret, body)
 *   - HubSpot v3: x-hubspot-signature-v3      = b64 HMAC-SHA256(secret,
 *                                                  method+uri+body+ts)
 *   - HubSpot v2: x-hubspot-signature         = hex HMAC-SHA256(secret, body)
 *   - SF custom: x-sf-signature               = hex HMAC-SHA256(secret, body)
 *
 * The normalizer collapses each vendor's event taxonomy into a small set the
 * rest of the app can act on: "opened" | "replied" | "bounced"
 * | "task_completed" | "other". Anything we don't recognize is still recorded
 * as a `reply_events` row with `eventType` = the raw vendor type.
 */
import crypto from "node:crypto";
import type { CrmType } from "./crmAdapters";

export type CanonicalEventType =
  | "opened"
  | "replied"
  | "bounced"
  | "task_completed"
  | "other";

export interface NormalizedEvent {
  canonical: CanonicalEventType;
  eventType: string;
  crmContactId: string | null;
  crmTaskId: string | null;
  occurredAt: Date | null;
  raw: unknown;
}

export interface VerifyContext {
  /** Full request path including query string, e.g. `/api/webhooks/hubspot/abc?x=1`. */
  originalUrl: string;
  method: string;
  /** `https` or `http`. Hosted on Replit so practically always `https`. */
  protocol: string;
  /** Host header value, e.g. `api.medintel.example`. */
  host: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function header(headers: VerifyContext["headers"], name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

export function verifySignature(
  crm: CrmType,
  secret: string,
  ctx: VerifyContext,
): VerifyResult {
  if (!secret) return { ok: false, reason: "no_webhook_secret_configured" };
  switch (crm) {
    case "ghl":
      return verifyGhl(secret, ctx);
    case "hubspot":
      return verifyHubspot(secret, ctx);
    case "salesforce":
      return verifySalesforce(secret, ctx);
  }
}

function verifyGhl(secret: string, ctx: VerifyContext): VerifyResult {
  const sig = header(ctx.headers, "x-wh-signature");
  if (!sig) return { ok: false, reason: "missing_signature_header" };
  const expected = crypto
    .createHmac("sha256", secret)
    .update(ctx.rawBody)
    .digest("hex");
  return timingSafeEqualStr(expected, sig.trim())
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

function verifyHubspot(secret: string, ctx: VerifyContext): VerifyResult {
  // Prefer v3 if present (timestamp + signature). Fall back to v2 hex digest.
  const sigV3 = header(ctx.headers, "x-hubspot-signature-v3");
  const ts = header(ctx.headers, "x-hubspot-request-timestamp");
  if (sigV3 && ts) {
    // Reject very old timestamps to limit replay attacks (5 minute window).
    const skewMs = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(skewMs) || skewMs > 5 * 60 * 1000) {
      return { ok: false, reason: "timestamp_skew_too_large" };
    }
    const uri = `${ctx.protocol}://${ctx.host}${ctx.originalUrl}`;
    const base = `${ctx.method.toUpperCase()}${uri}${ctx.rawBody.toString("utf8")}${ts}`;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(base)
      .digest("base64");
    return timingSafeEqualStr(expected, sigV3.trim())
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }
  const sigV2 = header(ctx.headers, "x-hubspot-signature");
  if (!sigV2) return { ok: false, reason: "missing_signature_header" };
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(ctx.rawBody)
    .digest("hex");
  return timingSafeEqualStr(expectedHex, sigV2.trim())
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

function verifySalesforce(secret: string, ctx: VerifyContext): VerifyResult {
  const sig = header(ctx.headers, "x-sf-signature");
  if (!sig) return { ok: false, reason: "missing_signature_header" };
  const expected = crypto
    .createHmac("sha256", secret)
    .update(ctx.rawBody)
    .digest("hex");
  return timingSafeEqualStr(expected, sig.trim())
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// Event normalizers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function classify(rawType: string): CanonicalEventType {
  const t = rawType.toLowerCase();
  if (t.includes("bounce")) return "bounced";
  if (t.includes("reply") || t.includes("inboundmessage") || t.includes("inbound_message")) {
    return "replied";
  }
  if (t.includes("open")) return "opened";
  if (t.includes("task") && (t.includes("complete") || t.includes("completed"))) {
    return "task_completed";
  }
  return "other";
}

export function parseEvents(crm: CrmType, body: unknown): NormalizedEvent[] {
  switch (crm) {
    case "ghl":
      return parseGhl(body);
    case "hubspot":
      return parseHubspot(body);
    case "salesforce":
      return parseSalesforce(body);
  }
}

function parseGhl(body: unknown): NormalizedEvent[] {
  // GHL posts a single object per event. Some webhooks wrap as { events: [...] }.
  const list: Array<Record<string, unknown>> = [];
  if (Array.isArray(body)) {
    for (const e of body) if (e && typeof e === "object") list.push(e as Record<string, unknown>);
  } else if (body && typeof body === "object") {
    const events = (body as { events?: unknown }).events;
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e && typeof e === "object") list.push(e as Record<string, unknown>);
      }
    } else {
      list.push(body as Record<string, unknown>);
    }
  }
  return list.map((e) => {
    const rawType =
      asString(e.type) ||
      asString(e.eventType) ||
      asString((e.event as { type?: unknown } | undefined)?.type) ||
      "unknown";
    const subType = asString(e.event) || asString((e as { subType?: unknown }).subType) || "";
    const fullType = subType && subType !== rawType ? `${rawType}.${subType}` : rawType;
    return {
      canonical: classify(fullType),
      eventType: fullType,
      crmContactId:
        asString(e.contactId) ||
        asString((e.contact as { id?: unknown } | undefined)?.id) ||
        null,
      crmTaskId:
        asString(e.taskId) ||
        asString((e.task as { id?: unknown } | undefined)?.id) ||
        null,
      occurredAt:
        asDate(e.dateAdded) || asDate(e.timestamp) || asDate(e.occurredAt) || null,
      raw: e,
    };
  });
}

function parseHubspot(body: unknown): NormalizedEvent[] {
  // HubSpot posts an array of subscription events.
  const list: Array<Record<string, unknown>> = Array.isArray(body)
    ? (body.filter((e) => e && typeof e === "object") as Array<Record<string, unknown>>)
    : body && typeof body === "object"
      ? [body as Record<string, unknown>]
      : [];
  return list.map((e) => {
    const rawType = asString(e.subscriptionType) || asString(e.type) || "unknown";
    const objectType = rawType.split(".")[0] ?? "";
    const objectId = asString(e.objectId);
    return {
      canonical: classify(rawType),
      eventType: rawType,
      // For email.* events HubSpot sets objectId to the contact (recipient) id.
      // For task.* events objectId is the task id; we surface that separately.
      crmContactId: objectType === "task" ? null : objectId,
      crmTaskId: objectType === "task" ? objectId : null,
      occurredAt: asDate(e.occurredAt) || asDate(e.eventTimestamp) || null,
      raw: e,
    };
  });
}

function parseSalesforce(body: unknown): NormalizedEvent[] {
  // Custom Apex/Flow webhook shape: { events: [{ type, whoId, taskId, occurredAt }] }
  // Also accept a single object for convenience.
  const list: Array<Record<string, unknown>> = [];
  if (Array.isArray(body)) {
    for (const e of body) if (e && typeof e === "object") list.push(e as Record<string, unknown>);
  } else if (body && typeof body === "object") {
    const events = (body as { events?: unknown }).events;
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e && typeof e === "object") list.push(e as Record<string, unknown>);
      }
    } else {
      list.push(body as Record<string, unknown>);
    }
  }
  return list.map((e) => {
    const rawType = asString(e.type) || asString(e.eventType) || "unknown";
    return {
      canonical: classify(rawType),
      eventType: rawType,
      crmContactId:
        asString(e.whoId) || asString(e.contactId) || asString(e.WhoId) || null,
      crmTaskId: asString(e.taskId) || asString(e.TaskId) || null,
      occurredAt: asDate(e.occurredAt) || asDate(e.CreatedDate) || null,
      raw: e,
    };
  });
}
