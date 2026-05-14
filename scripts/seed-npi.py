#!/usr/bin/env python3
"""
Streaming NPI seed script.

Reads directly from npi.zip without fully extracting (the main CSV is ~11 GB).
Filters for:
  - Entity Type Code = 2  (organizations, not individual providers)
  - Active records only   (NPI Deactivation Date is blank)
  - At least one taxonomy code matching imaging, radiology, hospital, or
    surgery-center prefixes relevant to medical-equipment sales

Upserts into the `facilities` table keyed on NPI — safe to re-run.

Usage:
  python3 scripts/seed-npi.py [--zip /path/to/npi.zip] [--batch 500] [--limit N] [--dry-run]

Defaults:
  --zip    /home/runner/workspace/npi.zip
  --batch  500   rows per INSERT batch
  --limit  0     0 = no limit (import everything that matches)
"""

import argparse
import csv
import io
import os
import sys
import time
import zipfile
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras

# ---------------------------------------------------------------------------
# Taxonomy filters — organisations whose primary or any taxonomy code starts
# with one of these prefixes (or exactly matches a full code) are imported.
# ---------------------------------------------------------------------------
TAXONOMY_PREFIXES = (
    "2085",       # Radiology practices
    "261QR",      # Radiology / imaging outpatient clinics
    "261QI",      # Imaging clinics
    "261QM",      # Multi-specialty clinics (imaging-heavy)
    "261QN",      # Nuclear medicine clinics
    "261QS",      # Surgery centres
    "282",        # Hospitals (general, long-term, religious, etc.)
    "283",        # Psychiatric / specialty hospitals
    "286",        # Military / VA hospitals
    "291",        # Laboratories (clinical / pathology)
    "292",        # Medical supplies / DME (keep for equipment context)
    "293",        # Emergency medical transport / ground ambulance
)

TAXONOMY_COLS = [f"Healthcare Provider Taxonomy Code_{i}" for i in range(1, 16)]

ZIP_PATH = "/home/runner/workspace/npi.zip"


def matches_taxonomy(row: dict) -> bool:
    for col in TAXONOMY_COLS:
        code = row.get(col, "").strip()
        if not code:
            continue
        for prefix in TAXONOMY_PREFIXES:
            if code.startswith(prefix):
                return True
    return False


def facility_type_from_row(row: dict) -> str:
    """Derive a human-readable facilityType from the best taxonomy code."""
    for col in TAXONOMY_COLS:
        code = row.get(col, "").strip()
        if not code:
            continue
        if code.startswith("2085"):
            return "radiology_practice"
        if code.startswith("261QR") or code.startswith("261QI") or code.startswith("261QN"):
            return "imaging_center"
        if code.startswith("261QS"):
            return "surgery_center"
        if code.startswith("261QM"):
            return "outpatient_clinic"
        if code.startswith("282") or code.startswith("283") or code.startswith("286"):
            return "hospital"
        if code.startswith("291"):
            return "laboratory"
        if code.startswith("292"):
            return "dme_supplier"
        if code.startswith("293"):
            return "ems"
    return "other"


def clean(val: str) -> str | None:
    v = val.strip()
    if not v or v in ("<UNAVAIL>", "N/A", "NA"):
        return None
    return v


def zip_5(postal: str | None) -> str | None:
    if not postal:
        return None
    return postal.strip()[:10] or None


def run(zip_path: str, batch_size: int, limit: int, dry_run: bool) -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL environment variable is not set.")

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # Ensure uuid_generate_v4() is available
    cur.execute("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";")
    conn.commit()

    upsert_sql = """
        INSERT INTO facilities (
            npi, name, doing_business_as, facility_type,
            address1, city, state, zip, system_name,
            ownership, signal_score, created_at, updated_at
        ) VALUES %s
        ON CONFLICT (npi) DO UPDATE SET
            name            = EXCLUDED.name,
            doing_business_as = EXCLUDED.doing_business_as,
            facility_type   = EXCLUDED.facility_type,
            address1        = EXCLUDED.address1,
            city            = EXCLUDED.city,
            state           = EXCLUDED.state,
            zip             = EXCLUDED.zip,
            system_name     = EXCLUDED.system_name,
            updated_at      = NOW()
    """

    print(f"Opening {zip_path} …")
    start = time.time()
    examined = inserted = skipped = errors = 0
    batch: list[tuple] = []

    def flush(final: bool = False) -> None:
        nonlocal inserted, errors
        if not batch:
            return
        if dry_run:
            print(f"  [dry-run] would upsert {len(batch)} rows")
            batch.clear()
            return
        try:
            psycopg2.extras.execute_values(cur, upsert_sql, batch, page_size=batch_size)
            conn.commit()
            inserted += len(batch)
        except Exception as exc:
            conn.rollback()
            errors += len(batch)
            print(f"  [error] batch failed: {exc}", file=sys.stderr)
        batch.clear()

    with zipfile.ZipFile(zip_path) as zf:
        # Find the main data file (not the fileheader, not pl_ or endpoint_)
        main_entry = next(
            n for n in zf.namelist()
            if n.startswith("npidata_pfile_") and not n.endswith("_fileheader.csv")
        )
        print(f"Streaming {main_entry} …\n")

        with zf.open(main_entry) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
            for row in reader:
                examined += 1

                # Progress ticker
                if examined % 100_000 == 0:
                    elapsed = time.time() - start
                    print(
                        f"  {examined:,} rows examined | {inserted:,} inserted | "
                        f"{skipped:,} skipped | {elapsed:.0f}s elapsed"
                    )

                # Only organisations
                if row.get("Entity Type Code", "").strip() != "2":
                    skipped += 1
                    continue

                # Skip deactivated records
                if row.get("NPI Deactivation Date", "").strip():
                    skipped += 1
                    continue

                if not matches_taxonomy(row):
                    skipped += 1
                    continue

                npi  = clean(row.get("NPI", ""))
                name = clean(row.get("Provider Organization Name (Legal Business Name)", ""))
                if not npi or not name:
                    skipped += 1
                    continue

                dba        = clean(row.get("Provider Other Organization Name", ""))
                fac_type   = facility_type_from_row(row)
                address1   = clean(row.get("Provider First Line Business Practice Location Address", ""))
                city       = clean(row.get("Provider Business Practice Location Address City Name", ""))
                state_val  = clean(row.get("Provider Business Practice Location Address State Name", ""))
                zip_val    = zip_5(row.get("Provider Business Practice Location Address Postal Code", ""))
                system_name = clean(row.get("Parent Organization LBN", ""))

                # Trim state to 2 chars (field is occasionally longer)
                if state_val and len(state_val) > 2:
                    state_val = state_val[:2]

                now = datetime.now(timezone.utc)
                batch.append((
                    npi, name, dba, fac_type,
                    address1, city, state_val, zip_val, system_name,
                    "unknown", 0, now, now,
                ))

                if len(batch) >= batch_size:
                    flush()

                if limit and inserted >= limit:
                    print(f"Reached --limit {limit}; stopping early.")
                    break

    flush(final=True)

    elapsed = time.time() - start
    print(f"\nDone in {elapsed:.1f}s")
    print(f"  Rows examined : {examined:,}")
    print(f"  Rows inserted : {inserted:,}")
    print(f"  Rows skipped  : {skipped:,}")
    print(f"  Errors        : {errors:,}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed facilities from NPI ZIP")
    parser.add_argument("--zip",     default=ZIP_PATH)
    parser.add_argument("--batch",   type=int, default=500)
    parser.add_argument("--limit",   type=int, default=0, help="0 = no limit")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(args.zip, args.batch, args.limit, args.dry_run)
