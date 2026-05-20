/**
 * Shared helpers for bulk-seed scripts.
 *
 * Storage layout (operator-configurable via env):
 *
 *   SEED_DATA_DIR  default: <repo-root>/.seed-data
 *     ├── nppes/      (the 11 GB NPI dissemination ZIP + unzipped CSV)
 *     ├── hcris/      (CMS hospital cost report ZIP/CSV)
 *     ├── fda/
 *     │   ├── 510k/
 *     │   ├── classification/
 *     │   ├── recall/
 *     │   └── maude/
 *     ├── clinical-trials/
 *     ├── nih-grants/
 *     ├── usa-spending/
 *     └── cms-provider/
 *
 * Each seed script:
 *   1. Downloads the bulk file (resumable; skipped if sha256 matches a prior run).
 *   2. Streams it into the matching `<source>_raw` staging table.
 *   3. Transforms staged rows into canonical tables (facilities, signals, …).
 *   4. Records the run in `source_seed_runs`.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { sql } from "drizzle-orm";
import { db, sourceSeedRuns } from "@workspace/db";
import { logger } from "../../lib/logger";

// ─── Storage location ──────────────────────────────────────────────────────

export function seedDataDir(): string {
  const fromEnv = process.env.SEED_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  // Default to <repo-root>/.seed-data — gitignored.
  return path.resolve(import.meta.dirname, "../../../../../.seed-data");
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

// ─── Download helper ───────────────────────────────────────────────────────

export interface DownloadResult {
  path: string;
  sha256: string;
  bytes: number;
  fromCache: boolean;
}

/**
 * Download a file to `<seedDataDir>/<subdir>/<filename>`. If the destination
 * already exists and matches `expectedSha256` (when provided), the existing
 * file is returned without re-downloading. Otherwise the file is streamed to
 * disk and its sha256 is computed on the fly.
 */
export async function downloadFile(opts: {
  url: string;
  subdir: string;
  filename: string;
  expectedSha256?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<DownloadResult> {
  const dir = await ensureDir(path.join(seedDataDir(), opts.subdir));
  const dest = path.join(dir, opts.filename);

  // Cache hit?
  try {
    const st = await stat(dest);
    if (opts.expectedSha256) {
      const sha = await fileSha256(dest);
      if (sha === opts.expectedSha256) {
        logger.info(
          { url: opts.url, dest, bytes: st.size, sha256: sha },
          "seed: cache-hit, skipping download",
        );
        return { path: dest, sha256: sha, bytes: st.size, fromCache: true };
      }
    } else if (st.size > 0) {
      // No expected sha provided — assume cache OK if the file is non-empty.
      // Operator can force redownload by deleting the file or passing --fresh.
      const sha = await fileSha256(dest);
      logger.info(
        { url: opts.url, dest, bytes: st.size, sha256: sha },
        "seed: existing file present, reusing",
      );
      return { path: dest, sha256: sha, bytes: st.size, fromCache: true };
    }
  } catch {
    // No file yet — fall through to download.
  }

  logger.info({ url: opts.url, dest }, "seed: downloading");
  const res = await fetch(opts.url, {
    headers: opts.headers,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} (${opts.url})`);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  const out = createWriteStream(dest);
  const reader = res.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hash.update(value);
      bytes += value.byteLength;
      if (!out.write(value)) {
        await new Promise((r) => out.once("drain", r));
      }
    }
  }
  out.end();
  await new Promise<void>((r, j) => {
    out.on("finish", () => r());
    out.on("error", j);
  });

  const sha256 = hash.digest("hex");
  logger.info({ url: opts.url, dest, bytes, sha256 }, "seed: download complete");
  return { path: dest, sha256, bytes, fromCache: false };
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), async function* (src) {
    for await (const chunk of src) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest("hex");
}

// ─── Run audit ─────────────────────────────────────────────────────────────

export interface StartSeedOpts {
  sourceName: string;
  fileUrl?: string;
  fileSha256?: string;
  fileBytes?: number;
  meta?: Record<string, unknown>;
}

export interface FinishSeedOpts {
  status: "ok" | "failed" | "skipped";
  rowsStaged?: number;
  rowsUpserted?: number;
  signalsInserted?: number;
  errorMessage?: string;
  meta?: Record<string, unknown>;
}

export async function startSeedRun(opts: StartSeedOpts): Promise<string> {
  const [row] = await db
    .insert(sourceSeedRuns)
    .values({
      sourceName: opts.sourceName,
      status: "running",
      fileUrl: opts.fileUrl,
      fileSha256: opts.fileSha256,
      fileBytes: opts.fileBytes,
      meta: (opts.meta ?? {}) as Record<string, unknown>,
    })
    .returning({ id: sourceSeedRuns.id });
  return row.id;
}

export async function finishSeedRun(runId: string, opts: FinishSeedOpts) {
  const startedAt = await db
    .select({ startedAt: sourceSeedRuns.startedAt })
    .from(sourceSeedRuns)
    .where(sql`id = ${runId}`)
    .limit(1);
  const durationMs =
    startedAt.length > 0 ? Date.now() - new Date(startedAt[0].startedAt).getTime() : null;

  await db.execute(sql`
    UPDATE source_seed_runs
       SET finished_at      = now(),
           duration_ms      = ${durationMs},
           status           = ${opts.status},
           rows_staged      = COALESCE(${opts.rowsStaged ?? null}::int, rows_staged),
           rows_upserted    = COALESCE(${opts.rowsUpserted ?? null}::int, rows_upserted),
           signals_inserted = COALESCE(${opts.signalsInserted ?? null}::int, signals_inserted),
           error_message    = ${opts.errorMessage ?? null},
           meta             = meta || ${JSON.stringify(opts.meta ?? {})}::jsonb
     WHERE id = ${runId}
  `);
}

/**
 * Has this source been seeded with a file matching this sha256 already?
 * If yes, the caller can short-circuit instead of re-running.
 */
export async function hasSuccessfulSeed(sourceName: string, fileSha256: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_seed_runs
     WHERE source_name = ${sourceName}
       AND file_sha256 = ${fileSha256}
       AND status      = 'ok'
     LIMIT 1
  `);
  return rows.rows.length > 0;
}

// ─── Batch upsert helper ──────────────────────────────────────────────────

/**
 * Wrap a long-running upsert in a single transaction with periodic
 * progress logging. `worker` receives a counter; return when done.
 */
export async function withProgress<T>(
  label: string,
  worker: (tick: (n?: number) => void) => Promise<T>,
): Promise<T> {
  let count = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
    const rps = Math.round(count / sec);
    logger.info({ label, count, sec, rps }, "seed: progress");
  }, 5000);
  try {
    const out = await worker((n = 1) => {
      count += n;
    });
    return out;
  } finally {
    clearInterval(timer);
    const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
    logger.info({ label, count, sec }, "seed: complete");
  }
}

// ─── CLI arg helpers ──────────────────────────────────────────────────────

export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}
