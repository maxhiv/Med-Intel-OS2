/**
 * Symmetric encryption used for at-rest secrets in JSONB columns
 * (currently sub_accounts.crm_credentials).
 *
 * Format stored in the column:
 *   { _encrypted: true, alg: "aes-256-gcm", v: 1, iv, tag, data }
 *
 * `data` is a base64-encoded JSON string of the cleartext credentials.
 * The key comes from the `CRM_ENCRYPTION_KEY` env var (32 raw bytes
 * encoded as base64 or hex).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_ENV = "CRM_ENCRYPTION_KEY";

export interface EncryptedBlob {
  _encrypted: true;
  alg: "aes-256-gcm";
  v: 1;
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

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Generate a 32-byte key (base64) and store it as a secret.`,
    );
  }
  const tryBase64 = Buffer.from(raw, "base64");
  if (tryBase64.length === 32) return tryBase64;
  const tryHex = Buffer.from(raw, "hex");
  if (tryHex.length === 32) return tryHex;
  throw new Error(
    `${KEY_ENV} must decode to 32 bytes (base64 or hex). Got ${tryBase64.length} base64 / ${tryHex.length} hex bytes.`,
  );
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
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

export function decryptJson<T = unknown>(blob: EncryptedBlob): T {
  const key = loadKey();
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
 * Mask a secret string for display. Keeps the last 4 visible characters,
 * everything else becomes "•". Returns "" for empty input.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value);
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(Math.max(4, s.length - 4)) + s.slice(-4);
}
