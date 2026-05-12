/**
 * Signed, short-lived state tokens for the CRM OAuth flow. The token binds
 * a subAccountId + userId + provider together so the callback can verify
 * the same browser session that initiated the flow is the one finishing it,
 * and that nobody is forging a callback to plant credentials onto a
 * sub-account they don't own.
 *
 * Format (URL-safe base64): `${payloadB64}.${sigB64}` where payload is
 * JSON `{ s: subAccountId, u: userId, p: provider, n: nonce, e: expiresAtMs }`.
 *
 * The signing key is derived from `CRM_ENCRYPTION_KEY` (already required by
 * the encryption module) so we don't introduce a second secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

interface OauthStatePayload {
  subAccountId: string;
  userId: string;
  provider: string;
  loginUrl?: string;
}

interface InternalPayload {
  s: string;
  u: string;
  p: string;
  l?: string;
  n: string;
  e: number;
}

function loadStateKey(): Buffer {
  const raw = process.env.CRM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CRM_ENCRYPTION_KEY is not set; OAuth state tokens cannot be signed.",
    );
  }
  // Derive a separate-purpose key so the HMAC key isn't byte-identical to
  // the AES key used to encrypt credentials at rest.
  return createHmac("sha256", raw).update("oauth-state-v1").digest();
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

export function signState(payload: OauthStatePayload): string {
  const internal: InternalPayload = {
    s: payload.subAccountId,
    u: payload.userId,
    p: payload.provider,
    l: payload.loginUrl,
    n: randomBytes(8).toString("hex"),
    e: Date.now() + STATE_TTL_MS,
  };
  const body = b64url(JSON.stringify(internal));
  const sig = b64url(createHmac("sha256", loadStateKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(token: string): OauthStatePayload | null {
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = createHmac("sha256", loadStateKey()).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let parsed: InternalPayload;
  try {
    parsed = JSON.parse(fromB64url(body).toString("utf8")) as InternalPayload;
  } catch {
    return null;
  }
  if (typeof parsed.e !== "number" || parsed.e < Date.now()) return null;
  if (!parsed.s || !parsed.u || !parsed.p) return null;
  return {
    subAccountId: parsed.s,
    userId: parsed.u,
    provider: parsed.p,
    loginUrl: parsed.l,
  };
}
