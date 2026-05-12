/**
 * Symmetric encryption used for at-rest secrets in JSONB columns
 * (currently sub_accounts.crm_credentials).
 *
 * Format stored in the column:
 *   { _encrypted: true, alg: "aes-256-gcm", v: 1, kid?, iv, tag, data }
 *
 * `data` is a base64-encoded JSON string of the cleartext credentials.
 * The primary key comes from the `CRM_ENCRYPTION_KEY` env var (32 raw
 * bytes encoded as base64 or hex). An optional `CRM_ENCRYPTION_KEY_PREVIOUS`
 * env var is recognized as a fallback decryption key — used during a
 * rotation window so existing blobs keep decrypting until the rotation
 * job re-encrypts them with the new primary key.
 *
 * `kid` is a short fingerprint (first 8 hex chars of sha256(key)) that
 * lets us identify which key encrypted a blob without leaking material.
 * Older blobs predate `kid` and are tolerated.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_ENV = "CRM_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "CRM_ENCRYPTION_KEY_PREVIOUS";

export interface EncryptedBlob {
  _encrypted: true;
  alg: "aes-256-gcm";
  v: 1;
  /** Optional key fingerprint (first 8 hex chars of sha256(key)). */
  kid?: string;
  iv: string;
  tag: string;
  data: string;
}

export function isEncryptedBlob(v: unknown): v is EncryptedBlob {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>)._encrypted === true &&
    typeof (v as Record<string, unknown>).iv === "string" &&
    typeof (v as Record<string, unknown>).data === "string" &&
    typeof (v as Record<string, unknown>).tag === "string"
  );
}

function decodeKey(raw: string, source: string): Buffer {
  const tryBase64 = Buffer.from(raw, "base64");
  if (tryBase64.length === 32) return tryBase64;
  const tryHex = Buffer.from(raw, "hex");
  if (tryHex.length === 32) return tryHex;
  throw new Error(
    `${source} must decode to 32 bytes (base64 or hex). Got ${tryBase64.length} base64 / ${tryHex.length} hex bytes.`,
  );
}

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Generate a 32-byte key (base64) and store it as a secret.`,
    );
  }
  return decodeKey(raw, KEY_ENV);
}

function loadPreviousKey(): Buffer | null {
  const raw = process.env[PREVIOUS_KEY_ENV];
  if (!raw) return null;
  return decodeKey(raw, PREVIOUS_KEY_ENV);
}

export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Public, non-secret fingerprint of the current primary key. */
export function currentKeyId(): string {
  return keyFingerprint(loadKey());
}

/** Public, non-secret fingerprint of the configured previous key (if any). */
export function previousKeyId(): string | null {
  const k = loadPreviousKey();
  return k ? keyFingerprint(k) : null;
}

export function encryptJson(value: unknown): EncryptedBlob {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _encrypted: true,
    alg: ALG,
    v: 1,
    kid: keyFingerprint(key),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

interface DecryptResult<T> {
  value: T;
  /** Which key actually decrypted the blob. */
  decryptedWith: "primary" | "previous";
}

function decryptWithKey<T>(blob: EncryptedBlob, key: Buffer): T {
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.data, "base64");
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Try to decrypt with the primary key, then fall back to
 * `CRM_ENCRYPTION_KEY_PREVIOUS` if it's configured. Returns which key
 * succeeded so callers (e.g. the rotation job) can know whether a blob
 * still needs to be re-encrypted.
 */
export function decryptJsonWithFallback<T = unknown>(
  blob: EncryptedBlob,
): DecryptResult<T> {
  const primary = loadKey();
  try {
    return { value: decryptWithKey<T>(blob, primary), decryptedWith: "primary" };
  } catch (primaryErr) {
    const prev = loadPreviousKey();
    if (!prev) throw primaryErr;
    try {
      return { value: decryptWithKey<T>(blob, prev), decryptedWith: "previous" };
    } catch {
      // Re-throw the primary error so callers see the more relevant failure.
      throw primaryErr;
    }
  }
}

export function decryptJson<T = unknown>(blob: EncryptedBlob): T {
  return decryptJsonWithFallback<T>(blob).value;
}

/**
 * Decode credentials stored in `sub_accounts.crm_credentials`.
 * Tolerates legacy plaintext rows so older sub-accounts keep working
 * until they're re-saved through the admin UI.
 */
export function decodeStoredCredentials<T = Record<string, unknown>>(
  raw: unknown,
): T {
  if (raw == null) return {} as T;
  if (isEncryptedBlob(raw)) return decryptJson<T>(raw);
  return raw as T;
}

/**
 * True when a blob is encrypted but not with the current primary key
 * (either it carries an out-of-date `kid`, or it's an old blob without
 * any `kid` at all). Used by the rotation job to decide what to re-encrypt.
 */
export function blobNeedsRotation(blob: EncryptedBlob, currentKid: string): boolean {
  return blob.kid !== currentKid;
}

/**
 * Mask a secret string for display. Keeps the last 4 visible characters,
 * everything else becomes "•". Returns "" for empty input.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value);
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(Math.max(4, s.length - 4)) + s.slice(-4);
}
