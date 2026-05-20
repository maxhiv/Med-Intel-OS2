/**
 * IRS 990 Import Runner — callable service extracted from the import990 script.
 *
 * Exports:
 *   runImport990(opts?)  Run the full 7-phase pipeline (or signals-only).
 *
 * All phases are identical to the original import990.ts script.  This module
 * exists so the same pipeline can be triggered via the HTTP admin endpoint
 * (POST /admin/run-990-import) without needing to spawn a child process.
 */

import path from "node:path";
import { createReadStream, statSync } from "node:fs";
import unzipper from "unzipper";
import { parse } from "csv-parse";
import { getTableColumns, sql } from "drizzle-orm";
import { db, irs990Raw } from "@workspace/db";
import { recomputeAllScores } from "./signalScorer";
import { logger } from "../lib/logger";

// ─── Defaults ─────────────────────────────────────────────────────────────────

const REPO_ROOT    = path.resolve(import.meta.dirname, "../../../../");
const DEFAULT_ZIP  = path.join(
  REPO_ROOT,
  "attached_assets/24eoextract990_1778864725332.zip",
);
const DEFAULT_BATCH_SIZE = 500;

const BMF_FILES = [
  path.join(REPO_ROOT, "attached_assets/eo1_1779206848043.csv"),
  path.join(REPO_ROOT, "attached_assets/eo2_1779206844990.csv"),
  path.join(REPO_ROOT, "attached_assets/eo3_1779206841644.csv"),
];

// Signal thresholds — exact per task spec
const FINANCIAL_HEALTH_MIN_REVENUE  = 1_000_000;
const CAPITAL_INVESTMENT_MIN_EQUIP  = 500_000;
const WORKFORCE_MIN_EMPLOYEES       = 50;
const WORKFORCE_MIN_OFFICER_COMP    = 100_000;

const TRGM_THRESHOLD_GENERAL  = 0.45;
const TRGM_THRESHOLD_HOSPITAL = 0.35;

function fmt(n: number) { return n.toLocaleString("en-US"); }

// ─── Column helpers (shared with the original script) ─────────────────────────

const _allCols  = getTableColumns(irs990Raw);
const _colNames = Object.values(_allCols).map(c => `"${c.name}"`).join(", ");
const _colKeys  = Object.keys(_allCols) as Array<keyof typeof _allCols>;

const CSV_SKIP = new Set(["ein", "ingestedAt", "facilityId", "matchScore", "matchedAt", "orgName"]);
const _conflictSet = Object.entries(_allCols)
  .filter(([k]) => !CSV_SKIP.has(k))
  .map(([k, col]) =>
    k === "updatedAt"
      ? `"${col.name}" = now()`
      : `"${col.name}" = excluded."${col.name}"`,
  )
  .join(", ");

function sqlLit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number")         return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

function toSmallint(v: string | undefined): number | null {
  if (!v?.trim()) return null;
  const n = parseInt(v.trim(), 10);
  return isNaN(n) ? null : n;
}
function toInt(v: string | undefined): number | null {
  if (!v?.trim()) return null;
  const n = parseInt(v.trim(), 10);
  return isNaN(n) ? null : n;
}
function toBigint(v: string | undefined): number | null {
  if (!v?.trim()) return null;
  const n = Number(v.trim());
  return isNaN(n) ? null : Math.round(n);
}
function toText(v: string | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function normalizeEin(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 2) return null;
  return digits.padStart(9, "0").slice(0, 9);
}

type IrsRow = typeof irs990Raw.$inferInsert;

function csvRecordToRow(rec: Record<string, string>): IrsRow | null {
  const ein = normalizeEin(rec["EIN"]);
  if (!ein) return null;

  return {
    ein,
    efile: toText(rec["efile"]),
    taxPd: toText(rec["tax_pd"]),
    subseccd: toSmallint(rec["subseccd"]),
    nonpfrea: toSmallint(rec["nonpfrea"]),
    s501c3or4947a1cd: toText(rec["s501c3or4947a1cd"]),
    schdbind: toText(rec["schdbind"]),
    politicalactvtscd: toText(rec["politicalactvtscd"]),
    lbbyingactvtscd: toText(rec["lbbyingactvtscd"]),
    subjto6033cd: toText(rec["subjto6033cd"]),
    dnradvisedfundscd: toText(rec["dnradvisedfundscd"]),
    prptyintrcvdcd: toText(rec["prptyintrcvdcd"]),
    maintwrkofartcd: toText(rec["maintwrkofartcd"]),
    crcounselingqstncd: toText(rec["crcounselingqstncd"]),
    hldassetsintermpermcd: toText(rec["hldassetsintermpermcd"]),
    rptlndbldgeqptcd: toText(rec["rptlndbldgeqptcd"]),
    rptinvstothsecd: toText(rec["rptinvstothsecd"]),
    rptinvstprgrelcd: toText(rec["rptinvstprgrelcd"]),
    rptothasstcd: toText(rec["rptothasstcd"]),
    rptothliabcd: toText(rec["rptothliabcd"]),
    sepcnsldtfinstmtcd: toText(rec["sepcnsldtfinstmtcd"]),
    sepindaudfinstmtcd: toText(rec["sepindaudfinstmtcd"]),
    inclinfinstmtcd: toText(rec["inclinfinstmtcd"]),
    operateschools170cd: toText(rec["operateschools170cd"]),
    frgnofficecd: toText(rec["frgnofficecd"]),
    frgnrevexpnscd: toText(rec["frgnrevexpnscd"]),
    frgngrntscd: toText(rec["frgngrntscd"]),
    frgnaggragrntscd: toText(rec["frgnaggragrntscd"]),
    rptprofndrsngfeescd: toText(rec["rptprofndrsngfeescd"]),
    rptincfnndrsngcd: toText(rec["rptincfnndrsngcd"]),
    rptincgamingcd: toText(rec["rptincgamingcd"]),
    operatehosptlcd: toText(rec["operatehosptlcd"]),
    hospaudfinstmtcd: toText(rec["hospaudfinstmtcd"]),
    rptgrntstogovtcd: toText(rec["rptgrntstogovtcd"]),
    rptgrntstoindvcd: toText(rec["rptgrntstoindvcd"]),
    rptyestocompnstncd: toText(rec["rptyestocompnstncd"]),
    txexmptbndcd: toText(rec["txexmptbndcd"]),
    invstproceedscd: toText(rec["invstproceedscd"]),
    maintescrwaccntcd: toText(rec["maintescrwaccntcd"]),
    actonbehalfcd: toText(rec["actonbehalfcd"]),
    engageexcessbnftcd: toText(rec["engageexcessbnftcd"]),
    awarexcessbnftcd: toText(rec["awarexcessbnftcd"]),
    loantofficercd: toText(rec["loantofficercd"]),
    grantoofficercd: toText(rec["grantoofficercd"]),
    dirbusnreltdcd: toText(rec["dirbusnreltdcd"]),
    fmlybusnreltdcd: toText(rec["fmlybusnreltdcd"]),
    servasofficercd: toText(rec["servasofficercd"]),
    recvnoncashcd: toText(rec["recvnoncashcd"]),
    recvartcd: toText(rec["recvartcd"]),
    ceaseoperationscd: toText(rec["ceaseoperationscd"]),
    sellorexchcd: toText(rec["sellorexchcd"]),
    ownsepentcd: toText(rec["ownsepentcd"]),
    reltdorgcd: toText(rec["reltdorgcd"]),
    intincntrlcd: toText(rec["intincntrlcd"]),
    orgtrnsfrcd: toText(rec["orgtrnsfrcd"]),
    conduct5percentcd: toText(rec["conduct5percentcd"]),
    compltschocd: toText(rec["compltschocd"]),
    f1096cnt: toInt(rec["f1096cnt"]),
    fw2gcnt: toInt(rec["fw2gcnt"]),
    wthldngrulescd: toText(rec["wthldngrulescd"]),
    noemplyeesw3cnt: toInt(rec["noemplyeesw3cnt"]),
    filerqrdrtnscd: toText(rec["filerqrdrtnscd"]),
    unrelbusinccd: toText(rec["unrelbusinccd"]),
    filedf990tcd: toText(rec["filedf990tcd"]),
    frgnacctcd: toText(rec["frgnacctcd"]),
    prohibtdtxshltrcd: toText(rec["prohibtdtxshltrcd"]),
    prtynotifyorgcd: toText(rec["prtynotifyorgcd"]),
    filedf8886tcd: toText(rec["filedf8886tcd"]),
    solicitcntrbcd: toText(rec["solicitcntrbcd"]),
    exprstmntcd: toText(rec["exprstmntcd"]),
    providegoodscd: toText(rec["providegoodscd"]),
    notfydnrvalcd: toText(rec["notfydnrvalcd"]),
    filedf8282cd: toText(rec["filedf8282cd"]),
    f8282cnt: toInt(rec["f8282cnt"]),
    fndsrcvdcd: toText(rec["fndsrcvdcd"]),
    premiumspaidcd: toText(rec["premiumspaidcd"]),
    filedf8899cd: toText(rec["filedf8899cd"]),
    filedf1098ccd: toText(rec["filedf1098ccd"]),
    excbushldngscd: toText(rec["excbushldngscd"]),
    s4966distribcd: toText(rec["s4966distribcd"]),
    distribtodonorcd: toText(rec["distribtodonorcd"]),
    initiationfees: toBigint(rec["initiationfees"]),
    grsrcptspublicuse: toBigint(rec["grsrcptspublicuse"]),
    grsincmembers: toBigint(rec["grsincmembers"]),
    grsincother: toBigint(rec["grsincother"]),
    filedlieuf1041cd: toText(rec["filedlieuf1041cd"]),
    txexmptint: toBigint(rec["txexmptint"]),
    qualhlthplncd: toText(rec["qualhlthplncd"]),
    qualhlthreqmntn: toBigint(rec["qualhlthreqmntn"]),
    qualhlthonhnd: toBigint(rec["qualhlthonhnd"]),
    rcvdpdtngcd: toText(rec["rcvdpdtngcd"]),
    filedf720cd: toText(rec["filedf720cd"]),
    totreprtabled: toBigint(rec["totreprtabled"]),
    totcomprelatede: toBigint(rec["totcomprelatede"]),
    totestcompf: toBigint(rec["totestcompf"]),
    noindiv100kcnt: toInt(rec["noindiv100kcnt"]),
    nocontractor100kcnt: toInt(rec["nocontractor100kcnt"]),
    totcntrbgfts: toBigint(rec["totcntrbgfts"]),
    prgmservcode2acd: toText(rec["prgmservcode2acd"]),
    totrev2acola: toBigint(rec["totrev2acola"]),
    prgmservcode2bcd: toText(rec["prgmservcode2bcd"]),
    totrev2bcola: toBigint(rec["totrev2bcola"]),
    prgmservcode2ccd: toText(rec["prgmservcode2ccd"]),
    totrev2ccola: toBigint(rec["totrev2ccola"]),
    prgmservcode2dcd: toText(rec["prgmservcode2dcd"]),
    totrev2dcola: toBigint(rec["totrev2dcola"]),
    prgmservcode2ecd: toText(rec["prgmservcode2ecd"]),
    totrev2ecola: toBigint(rec["totrev2ecola"]),
    totrev2fcola: toBigint(rec["totrev2fcola"]),
    totprgmrevnue: toBigint(rec["totprgmrevnue"]),
    invstmntinc: toBigint(rec["invstmntinc"]),
    txexmptbndsproceeds: toBigint(rec["txexmptbndsproceeds"]),
    royaltsinc: toBigint(rec["royaltsinc"]),
    grsrntsreal: toBigint(rec["grsrntsreal"]),
    grsrntsprsnl: toBigint(rec["grsrntsprsnl"]),
    rntlexpnsreal: toBigint(rec["rntlexpnsreal"]),
    rntlexpnsprsnl: toBigint(rec["rntlexpnsprsnl"]),
    rntlincreal: toBigint(rec["rntlincreal"]),
    rntlincprsnl: toBigint(rec["rntlincprsnl"]),
    netrntlinc: toBigint(rec["netrntlinc"]),
    grsalesecur: toBigint(rec["grsalesecur"]),
    grsalesothr: toBigint(rec["grsalesothr"]),
    cstbasisecur: toBigint(rec["cstbasisecur"]),
    cstbasisothr: toBigint(rec["cstbasisothr"]),
    gnlsecur: toBigint(rec["gnlsecur"]),
    gnlsothr: toBigint(rec["gnlsothr"]),
    netgnls: toBigint(rec["netgnls"]),
    grsincfndrsng: toBigint(rec["grsincfndrsng"]),
    lessdirfndrsng: toBigint(rec["lessdirfndrsng"]),
    netincfndrsng: toBigint(rec["netincfndrsng"]),
    grsincgaming: toBigint(rec["grsincgaming"]),
    lessdirgaming: toBigint(rec["lessdirgaming"]),
    netincgaming: toBigint(rec["netincgaming"]),
    grsalesinvent: toBigint(rec["grsalesinvent"]),
    lesscstofgoods: toBigint(rec["lesscstofgoods"]),
    netincsales: toBigint(rec["netincsales"]),
    miscrev11acd: toText(rec["miscrev11acd"]),
    miscrevtota: toBigint(rec["miscrevtota"]),
    miscrev11bcd: toText(rec["miscrev11bcd"]),
    miscrevtot11b: toBigint(rec["miscrevtot11b"]),
    miscrev11ccd: toText(rec["miscrev11ccd"]),
    miscrevtot11c: toBigint(rec["miscrevtot11c"]),
    miscrevtot11d: toBigint(rec["miscrevtot11d"]),
    miscrevtot11e: toBigint(rec["miscrevtot11e"]),
    totrevenue: toBigint(rec["totrevenue"]),
    grntstogovt: toBigint(rec["grntstogovt"]),
    grnsttoindiv: toBigint(rec["grnsttoindiv"]),
    grntstofrgngovt: toBigint(rec["grntstofrgngovt"]),
    benifitsmembrs: toBigint(rec["benifitsmembrs"]),
    compnsatncurrofcr: toBigint(rec["compnsatncurrofcr"]),
    compnsatnandothr: toBigint(rec["compnsatnandothr"]),
    othrsalwages: toBigint(rec["othrsalwages"]),
    pensionplancontrb: toBigint(rec["pensionplancontrb"]),
    othremplyeebenef: toBigint(rec["othremplyeebenef"]),
    payrolltx: toBigint(rec["payrolltx"]),
    feesforsrvcmgmt: toBigint(rec["feesforsrvcmgmt"]),
    legalfees: toBigint(rec["legalfees"]),
    accntingfees: toBigint(rec["accntingfees"]),
    feesforsrvclobby: toBigint(rec["feesforsrvclobby"]),
    profndraising: toBigint(rec["profndraising"]),
    feesforsrvcinvstmgmt: toBigint(rec["feesforsrvcinvstmgmt"]),
    feesforsrvcothr: toBigint(rec["feesforsrvcothr"]),
    advrtpromo: toBigint(rec["advrtpromo"]),
    officexpns: toBigint(rec["officexpns"]),
    infotech: toBigint(rec["infotech"]),
    royaltsexpns: toBigint(rec["royaltsexpns"]),
    occupancy: toBigint(rec["occupancy"]),
    travel: toBigint(rec["travel"]),
    travelofpublicoffcl: toBigint(rec["travelofpublicoffcl"]),
    converconventmtng: toBigint(rec["converconventmtng"]),
    interestamt: toBigint(rec["interestamt"]),
    pymtoaffiliates: toBigint(rec["pymtoaffiliates"]),
    deprcatndepletn: toBigint(rec["deprcatndepletn"]),
    insurance: toBigint(rec["insurance"]),
    othrexpnsa: toBigint(rec["othrexpnsa"]),
    othrexpnsb: toBigint(rec["othrexpnsb"]),
    othrexpnsc: toBigint(rec["othrexpnsc"]),
    othrexpnsd: toBigint(rec["othrexpnsd"]),
    othrexpnse: toBigint(rec["othrexpnse"]),
    othrexpnsf: toBigint(rec["othrexpnsf"]),
    totfuncexpns: toBigint(rec["totfuncexpns"]),
    nonintcashend: toBigint(rec["nonintcashend"]),
    svngstempinvend: toBigint(rec["svngstempinvend"]),
    pldgegrntrcvblend: toBigint(rec["pldgegrntrcvblend"]),
    accntsrcvblend: toBigint(rec["accntsrcvblend"]),
    currfrmrcvblend: toBigint(rec["currfrmrcvblend"]),
    rcvbldisqualend: toBigint(rec["rcvbldisqualend"]),
    notesloansrcvblend: toBigint(rec["notesloansrcvblend"]),
    invntriesalesend: toBigint(rec["invntriesalesend"]),
    prepaidexpnsend: toBigint(rec["prepaidexpnsend"]),
    lndbldgsequipend: toBigint(rec["lndbldgsequipend"]),
    invstmntsend: toBigint(rec["invstmntsend"]),
    invstmntsothrend: toBigint(rec["invstmntsothrend"]),
    invstmntsprgmend: toBigint(rec["invstmntsprgmend"]),
    intangibleassetsend: toBigint(rec["intangibleassetsend"]),
    othrassetsend: toBigint(rec["othrassetsend"]),
    totassetsend: toBigint(rec["totassetsend"]),
    accntspayableend: toBigint(rec["accntspayableend"]),
    grntspayableend: toBigint(rec["grntspayableend"]),
    deferedrevnuend: toBigint(rec["deferedrevnuend"]),
    txexmptbndsend: toBigint(rec["txexmptbndsend"]),
    escrwaccntliabend: toBigint(rec["escrwaccntliabend"]),
    paybletoffcrsend: toBigint(rec["paybletoffcrsend"]),
    secrdmrtgsend: toBigint(rec["secrdmrtgsend"]),
    unsecurednotesend: toBigint(rec["unsecurednotesend"]),
    othrliabend: toBigint(rec["othrliabend"]),
    totliabend: toBigint(rec["totliabend"]),
    unrstrctnetasstsend: toBigint(rec["unrstrctnetasstsend"]),
    temprstrctnetasstsend: toBigint(rec["temprstrctnetasstsend"]),
    permrstrctnetasstsend: toBigint(rec["permrstrctnetasstsend"]),
    capitalstktrstend: toBigint(rec["capitalstktrstend"]),
    paidinsurplusend: toBigint(rec["paidinsurplusend"]),
    retainedearnend: toBigint(rec["retainedearnend"]),
    totnetassetend: toBigint(rec["totnetassetend"]),
    totnetliabastend: toBigint(rec["totnetliabastend"]),
    totnooforgscnt: toInt(rec["totnooforgscnt"]),
    totsupport: toBigint(rec["totsupport"]),
    gftgrntsrcvd170: toBigint(rec["gftgrntsrcvd170"]),
    txrevnuelevied170: toBigint(rec["txrevnuelevied170"]),
    srvcsval170: toBigint(rec["srvcsval170"]),
    pubsuppsubtot170: toBigint(rec["pubsuppsubtot170"]),
    exceeds2pct170: toBigint(rec["exceeds2pct170"]),
    pubsupplesspct170: toBigint(rec["pubsupplesspct170"]),
    samepubsuppsubtot170: toBigint(rec["samepubsuppsubtot170"]),
    grsinc170: toBigint(rec["grsinc170"]),
    netincunreltd170: toBigint(rec["netincunreltd170"]),
    othrinc170: toBigint(rec["othrinc170"]),
    totsupp170: toBigint(rec["totsupp170"]),
    grsrcptsrelated170: toBigint(rec["grsrcptsrelated170"]),
    totgftgrntrcvd509: toBigint(rec["totgftgrntrcvd509"]),
    grsrcptsadmissn509: toBigint(rec["grsrcptsadmissn509"]),
    grsrcptsactivities509: toBigint(rec["grsrcptsactivities509"]),
    txrevnuelevied509: toBigint(rec["txrevnuelevied509"]),
    srvcsval509: toBigint(rec["srvcsval509"]),
    pubsuppsubtot509: toBigint(rec["pubsuppsubtot509"]),
    rcvdfrmdisqualsub509: toBigint(rec["rcvdfrmdisqualsub509"]),
    exceeds1pct509: toBigint(rec["exceeds1pct509"]),
    subtotpub509: toBigint(rec["subtotpub509"]),
    pubsupplesub509: toBigint(rec["pubsupplesub509"]),
    samepubsuppsubtot509: toBigint(rec["samepubsuppsubtot509"]),
    grsinc509: toBigint(rec["grsinc509"]),
    unreltxincls511tx509: toBigint(rec["unreltxincls511tx509"]),
    subtotsuppinc509: toBigint(rec["subtotsuppinc509"]),
    netincunrelatd509: toBigint(rec["netincunrelatd509"]),
    othrinc509: toBigint(rec["othrinc509"]),
    totsupp509: toBigint(rec["totsupp509"]),
  };
}

// ─── Batch flush ──────────────────────────────────────────────────────────────

async function flushBatch(rawBatch: IrsRow[]): Promise<void> {
  if (!rawBatch.length) return;
  const seen = new Map<string, IrsRow>();
  for (const row of rawBatch) {
    const existing = seen.get(row.ein!);
    if (!existing || (String(row.taxPd ?? "") > String(existing.taxPd ?? ""))) {
      seen.set(row.ein!, row);
    }
  }
  const deduped = Array.from(seen.values());
  const valuesSql = deduped
    .map(row => `(${_colKeys.map(k => sqlLit(row[k])).join(", ")})`)
    .join(",\n");
  await db.execute(sql.raw(
    `INSERT INTO irs_990_raw (${_colNames}) VALUES ${valuesSql}
     ON CONFLICT (ein) DO UPDATE SET ${_conflictSet}`,
  ));
}

// ─── Phase 1: CSV import ──────────────────────────────────────────────────────

async function importCsv(
  zipPath: string,
  batchSize: number,
): Promise<{ rowsProcessed: number; rowsSkipped: number }> {
  logger.info(`  Streaming inner CSV from ZIP (no temp file)...`);

  // Pre-flight: file exists + plausibly a real ZIP (not a Git LFS pointer).
  let zipBytes = 0;
  try {
    zipBytes = statSync(zipPath).size;
  } catch (err) {
    throw new Error(`ZIP not found at ${zipPath}: ${(err as Error).message}`);
  }
  if (zipBytes < 256) {
    throw new Error(
      `ZIP at ${zipPath} is only ${zipBytes} bytes — looks like a Git LFS pointer or truncated download. Re-fetch the actual IRS 990 extract.`,
    );
  }

  // Use unzipper's `Open.file` API instead of the Parse-stream API. See the
  // matching block in scripts/import990.ts for the full rationale: on Node 22
  // + Replit, the Parse-stream 'entry' / 'finish' / 'end' events sometimes
  // silently never fire, and the promise hangs until Node's unsettled-await
  // guard kills the process (exit code 13). Open.file is event-loop-safe.
  const directory = await unzipper.Open.file(zipPath);
  const csvFile = directory.files.find((f) => f.path.endsWith(".csv"));
  if (!csvFile) {
    throw new Error(`No .csv entry found inside ZIP ${zipPath}`);
  }
  logger.info(`  Found CSV entry: ${csvFile.path} — streaming into parser...`);

  return new Promise((resolve, reject) => {
    let rowsProcessed = 0;
    let rowsSkipped   = 0;
    let batch: IrsRow[] = [];
    let flushChain     = Promise.resolve<void>(undefined);
    let lastLogCount   = 0;
    let settled        = false;

    function done(err?: unknown) {
      if (settled) return;
      settled = true;
      if (err) { reject(err); return; }
      flushChain
        .then(() => resolve({ rowsProcessed, rowsSkipped }))
        .catch(reject);
    }

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    parser.on("readable", () => {
      let rec: Record<string, string>;
      while ((rec = parser.read())) {
        const row = csvRecordToRow(rec);
        if (!row) { rowsSkipped++; continue; }
        batch.push(row);
        rowsProcessed++;
        if (batch.length >= batchSize) {
          const toFlush = batch;
          batch = [];
          flushChain = flushChain.then(() => flushBatch(toFlush));
        }
        if (rowsProcessed - lastLogCount >= 10_000) {
          logger.info(`    ... ${fmt(rowsProcessed)} rows processed`);
          lastLogCount = rowsProcessed;
        }
      }
    });

    parser.on("end", () => {
      if (batch.length > 0) {
        flushChain = flushChain.then(() => flushBatch(batch));
      }
      done();
    });

    parser.on("error", (err) => done(err));

    const csvStream = csvFile.stream();
    csvStream.on("error", (err) => done(err));
    csvStream.pipe(parser);
  });
}

// ─── Phase 2: Direct EIN match ────────────────────────────────────────────────

async function directEinMatch(): Promise<number> {
  await db.execute(sql.raw(`
    UPDATE irs_990_raw i
    SET facility_id = f.id,
        match_score = 1.000,
        matched_at  = now()
    FROM facilities f
    WHERE f.ein = i.ein
      AND i.facility_id IS NULL
  `));
  const [row] = (await db.execute<{ cnt: string }>(sql.raw(`
    SELECT COUNT(*)::text AS cnt FROM irs_990_raw WHERE facility_id IS NOT NULL
  `))).rows;
  return Number(row.cnt);
}

// ─── Phase 3: BMF name population ────────────────────────────────────────────

async function populateBmfNames(): Promise<number> {
  const BMF_BATCH = 500;
  const einToName = new Map<string, string>();
  for (const filePath of BMF_FILES) {
    await new Promise<void>((resolve, reject) => {
      const parser = parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
      createReadStream(filePath)
        .on("error", reject)
        .pipe(parser);
      parser.on("data", (row: Record<string, string>) => {
        const ein  = (row["EIN"]  ?? "").trim();
        const name = (row["NAME"] ?? "").trim();
        if (ein && name && !einToName.has(ein)) einToName.set(ein, name);
      });
      parser.on("end",   resolve);
      parser.on("error", reject);
    });
    logger.info(`    BMF loaded: ${path.basename(filePath)} (running total: ${fmt(einToName.size)} EINs)`);
  }

  const entries = [...einToName.entries()];
  let updated = 0;
  for (let i = 0; i < entries.length; i += BMF_BATCH) {
    const batch = entries.slice(i, i + BMF_BATCH);
    const values = batch
      .map(([ein, name]) => `('${ein.replace(/'/g, "''")}','${name.replace(/'/g, "''")}')`)
      .join(",");
    const res = await db.execute<{ ein: string }>(sql.raw(`
      UPDATE irs_990_raw r
      SET org_name = v.name
      FROM (VALUES ${values}) AS v(ein, name)
      WHERE r.ein = v.ein
        AND r.org_name IS NULL
      RETURNING r.ein
    `));
    updated += res.rows.length;
  }
  return updated;
}

// ─── Phase 4: pg_trgm match ───────────────────────────────────────────────────

async function trgmMatch(): Promise<number> {
  const TRGM_BATCH = 200;

  const [unmatchedRow] = (await db.execute<{ cnt: string }>(sql.raw(
    `SELECT COUNT(*)::text AS cnt FROM irs_990_raw WHERE facility_id IS NULL`,
  ))).rows;
  logger.info(`  Phase 4 trgm: ${fmt(Number(unmatchedRow.cnt))} rows unmatched after EIN join...`);

  async function runPass(threshold: number, hospitalOnly: boolean): Promise<number> {
    const allEins = (await db.execute<{ ein: string }>(sql.raw(`
      SELECT ein FROM irs_990_raw
      WHERE facility_id IS NULL
        AND org_name    IS NOT NULL
        ${hospitalOnly ? "AND operatehosptlcd = 'Y'" : ""}
      ORDER BY ein
    `))).rows.map((r) => r.ein);

    let matched = 0;
    for (let i = 0; i < allEins.length; i += TRGM_BATCH) {
      const einList = allEins
        .slice(i, i + TRGM_BATCH)
        .map((e) => `'${e.replace(/'/g, "''")}'`)
        .join(", ");

      const res = await db.execute<{ cnt: string }>(sql.raw(`
        WITH candidates AS (
          SELECT r.ein,
                 f.id                            AS fac_id,
                 similarity(r.org_name, f.name)  AS sim
          FROM irs_990_raw r
          JOIN facilities  f
               ON similarity(r.org_name, f.name) >= ${threshold}
          WHERE r.ein IN (${einList})
            AND r.facility_id IS NULL
            AND r.org_name    IS NOT NULL
            ${hospitalOnly ? "AND r.operatehosptlcd = 'Y'" : ""}
        ),
        ranked AS (
          SELECT ein, fac_id, sim,
            ROW_NUMBER() OVER (PARTITION BY ein ORDER BY sim DESC) AS rn
          FROM candidates
        ),
        upd_990 AS (
          UPDATE irs_990_raw r
          SET facility_id = ranked.fac_id,
              match_score = ranked.sim,
              matched_at  = now()
          FROM ranked
          WHERE r.ein = ranked.ein AND ranked.rn = 1
          RETURNING r.ein, ranked.fac_id
        ),
        upd_fac AS (
          UPDATE facilities f
          SET ein        = upd_990.ein,
              updated_at = now()
          FROM upd_990
          WHERE f.id = upd_990.fac_id
            AND f.ein IS NULL
        )
        SELECT COUNT(*)::text AS cnt FROM upd_990
      `));
      matched += Number(res.rows[0]?.cnt ?? 0);
    }
    return matched;
  }

  const generalMatched  = await runPass(TRGM_THRESHOLD_GENERAL,  false);
  const hospitalMatched = await runPass(TRGM_THRESHOLD_HOSPITAL, true);
  logger.info(`  trgm: ${fmt(generalMatched)} general + ${fmt(hospitalMatched)} hospital = ${fmt(generalMatched + hospitalMatched)} total.`);
  return generalMatched + hospitalMatched;
}

// ─── Phase 5: financial_documents upsert ─────────────────────────────────────

async function upsertFinancialDocs(): Promise<number> {
  const result = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO financial_documents (
      facility_id, doc_type, fiscal_year, total_revenue, operating_income,
      capital_expenditures, long_term_debt, net_patient_revenue, ingested_at
    )
    SELECT
      i.facility_id,
      'irs_990',
      CASE
        WHEN i.tax_pd IS NOT NULL AND length(i.tax_pd) >= 4
          THEN (left(i.tax_pd, 4))::smallint
        ELSE date_part('year', now())::smallint
      END,
      i.totrevenue,
      CASE
        WHEN i.totrevenue IS NOT NULL AND i.totfuncexpns IS NOT NULL
          THEN i.totrevenue - i.totfuncexpns
        ELSE NULL
      END,
      i.deprcatndepletn,
      COALESCE(i.secrdmrtgsend, 0) + COALESCE(i.unsecurednotesend, 0),
      i.totprgmrevnue,
      now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL
    ON CONFLICT (facility_id, doc_type, fiscal_year) DO UPDATE SET
      total_revenue        = EXCLUDED.total_revenue,
      operating_income     = EXCLUDED.operating_income,
      capital_expenditures = EXCLUDED.capital_expenditures,
      long_term_debt       = EXCLUDED.long_term_debt,
      net_patient_revenue  = EXCLUDED.net_patient_revenue,
      ingested_at          = now()
    RETURNING id
  `));
  return result.rows.length;
}

// ─── Phase 6: emit purchase signals ──────────────────────────────────────────

function revenueDecileConf(revenue: number): number {
  const deciles = [
    1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000,
    50_000_000, 100_000_000, 250_000_000, 500_000_000,
  ];
  let decile = 0;
  for (const d of deciles) {
    if (revenue > d) decile++;
    else break;
  }
  return Math.round(40 + (decile / 9) * 55);
}

async function emitSignals(): Promise<{ total: number; byType: Record<string, number> }> {
  const counts: Record<string, number> = {};

  await db.execute(sql.raw(`
    DELETE FROM purchase_signals
    WHERE source = 'irs_990'
      AND facility_id IN (
        SELECT DISTINCT facility_id FROM irs_990_raw WHERE facility_id IS NOT NULL
      )
  `));

  const hospRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, is_active, detected_at)
    SELECT i.facility_id, 'hospital_operator', 'irs_990:hospital:' || i.ein, 90, 'irs_990', true, now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL AND i.operatehosptlcd = 'Y'
    ON CONFLICT DO NOTHING RETURNING id
  `));
  counts["hospital_operator"] = hospRes.rows.length;
  logger.info(`    hospital_operator  : ${fmt(hospRes.rows.length)}`);

  const capRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      i.facility_id, 'capital_investment', 'irs_990:capex:' || i.ein, 75, 'irs_990',
      jsonb_build_object('lndbldgsequipend', i.lndbldgsequipend, 'deprcatndepletn', i.deprcatndepletn, 'totassetsend', i.totassetsend),
      true, now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL AND i.lndbldgsequipend > ${CAPITAL_INVESTMENT_MIN_EQUIP}
    ON CONFLICT DO NOTHING RETURNING id
  `));
  counts["capital_investment"] = capRes.rows.length;
  logger.info(`    capital_investment : ${fmt(capRes.rows.length)}`);

  const workRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      i.facility_id, 'workforce_expansion', 'irs_990:workforce:' || i.ein, 65, 'irs_990',
      jsonb_build_object('noemplyeesw3cnt', i.noemplyeesw3cnt, 'compnsatncurrofcr', i.compnsatncurrofcr),
      true, now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL
      AND i.noemplyeesw3cnt > ${WORKFORCE_MIN_EMPLOYEES}
      AND i.compnsatncurrofcr > ${WORKFORCE_MIN_OFFICER_COMP}
    ON CONFLICT DO NOTHING RETURNING id
  `));
  counts["workforce_expansion"] = workRes.rows.length;
  logger.info(`    workforce_expansion: ${fmt(workRes.rows.length)}`);

  const healthRows = await db.execute<{
    facility_id: string;
    ein: string;
    totrevenue: string;
    totnetassetend: string | null;
    totliabend: string | null;
  }>(sql.raw(`
    SELECT facility_id, ein, totrevenue, totnetassetend, totliabend
    FROM irs_990_raw
    WHERE facility_id IS NOT NULL AND totrevenue > ${FINANCIAL_HEALTH_MIN_REVENUE}
  `));

  let healthCount = 0;
  const HEALTH_BATCH = 500;
  const healthBatch  = healthRows.rows;
  for (let i = 0; i < healthBatch.length; i += HEALTH_BATCH) {
    const chunk = healthBatch.slice(i, i + HEALTH_BATCH);
    const values = chunk.map((r) => {
      const conf = revenueDecileConf(Number(r.totrevenue ?? 0));
      const meta = JSON.stringify({
        totrevenue: r.totrevenue ?? null,
        totnetassetend: r.totnetassetend ?? null,
        totliabend: r.totliabend ?? null,
      }).replace(/'/g, "''");
      return `('${r.facility_id}','financial_health','irs_990:health:${r.ein}',${conf},'irs_990','${meta}',true,now())`;
    }).join(",");
    const res = await db.execute<{ id: string }>(sql.raw(`
      INSERT INTO purchase_signals
        (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
      VALUES ${values}
      ON CONFLICT DO NOTHING RETURNING id
    `));
    healthCount += res.rows.length;
  }
  counts["financial_health"] = healthCount;
  logger.info(`    financial_health   : ${fmt(healthCount)}`);

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { total, byType: counts };
}

// ─── Public result type ───────────────────────────────────────────────────────

export interface Import990Result {
  rowsProcessed: number;
  rowsSkipped: number;
  bmfNamed: number;
  directMatched: number;
  trgmMatched: number;
  financialDocs: number;
  signals: { total: number; byType: Record<string, number> };
  scoresUpdated: number;
  elapsedMs: number;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface Import990Options {
  signalsOnly?: boolean;
  zipPath?: string;
  batchSize?: number;
}

export async function runImport990(opts: Import990Options = {}): Promise<Import990Result> {
  const zipPath   = opts.zipPath   ?? process.env.IRS_990_ZIP_PATH ?? DEFAULT_ZIP;
  const batchSize = opts.batchSize ?? Math.max(100, Number(process.env.IRS_990_BATCH_SIZE ?? DEFAULT_BATCH_SIZE));
  const signalsOnly = opts.signalsOnly ?? process.env.IRS_990_SIGNALS_ONLY === "1";

  logger.info("\n" + "═".repeat(68));
  logger.info("  MedIntel OS — IRS 990 Import Runner");
  logger.info(`  ZIP        : ${zipPath}`);
  logger.info(`  Batch size : ${fmt(batchSize)}`);
  logger.info(`  Mode       : ${signalsOnly ? "SIGNALS_ONLY (skip CSV import)" : "FULL"}`);
  logger.info("═".repeat(68) + "\n");

  const t0 = Date.now();
  let rowsProcessed = 0;
  let rowsSkipped   = 0;

  if (!signalsOnly) {
    logger.info("  [1/7] Streaming CSV into irs_990_raw...");
    ({ rowsProcessed, rowsSkipped } = await importCsv(zipPath, batchSize));
    logger.info(`  Done: ${fmt(rowsProcessed)} rows ingested, ${fmt(rowsSkipped)} skipped.\n`);
  } else {
    logger.info("  [1/7] Skipping CSV import (signalsOnly=true).\n");
  }

  const [raw] = (await db.execute<{ total: string; hospitals: string }>(sql.raw(`
    SELECT
      COUNT(*)::text                                    AS total,
      COUNT(*) FILTER (WHERE operatehosptlcd='Y')::text AS hospitals
    FROM irs_990_raw
  `))).rows;
  logger.info(`  [2/7] irs_990_raw: ${fmt(Number(raw.total))} rows, ${fmt(Number(raw.hospitals))} hospitals`);

  logger.info("\n  [3/7] Direct EIN match...");
  const directMatched = await directEinMatch();
  logger.info(`  Total matched: ${fmt(directMatched)} rows linked to a facility.`);

  logger.info("\n  [4/7] Populating org_name from BMF (eo1/eo2/eo3)...");
  const bmfNamed = await populateBmfNames();
  logger.info(`  BMF: org_name populated for ${fmt(bmfNamed)} rows.`);

  logger.info("\n  [5/7] pg_trgm name match pass...");
  const trgmMatched = await trgmMatch();
  logger.info(`  trgm matched: ${fmt(trgmMatched)} additional facilities.`);

  logger.info("\n  [6/7] Upserting financial_documents...");
  const financialDocs = await upsertFinancialDocs();
  logger.info(`  Upserted ${fmt(financialDocs)} financial_documents rows.`);

  logger.info("\n  [7/7] Emitting purchase signals...");
  const signals = await emitSignals();
  logger.info(`\n  Total signals emitted: ${fmt(signals.total)}`);

  logger.info("\n  Persisting hospital flag on matched facilities...");
  const hospFlagRes = await db.execute<{ cnt: string }>(sql.raw(`
    WITH updated AS (
      UPDATE facilities f
      SET operates_hospital = true, updated_at = now()
      FROM irs_990_raw r
      WHERE r.facility_id = f.id
        AND r.operatehosptlcd = 'Y'
        AND f.operates_hospital = false
      RETURNING f.id
    )
    SELECT COUNT(*)::text AS cnt FROM updated
  `));
  logger.info(`  operates_hospital set on ${fmt(Number(hospFlagRes.rows[0]?.cnt ?? 0))} facilities.`);

  logger.info("\n  Recomputing scores for all facilities...");
  const { updated: scoresUpdated } = await recomputeAllScores();
  logger.info(`  Scores updated for ${fmt(scoresUpdated)} facilities.`);

  const elapsedMs = Date.now() - t0;
  logger.info("\n" + "═".repeat(68));
  logger.info("  Final metrics:");
  logger.info(`    Rows processed  : ${fmt(Number(raw.total))}`);
  logger.info(`    EINs from BMF   : ${fmt(bmfNamed)}`);
  logger.info(`    Matched direct  : ${fmt(directMatched)}`);
  logger.info(`    Matched trgm    : ${fmt(trgmMatched)}`);
  logger.info(`    Signals emitted : ${fmt(signals.total)}`);
  logger.info(`    Elapsed         : ${(elapsedMs / 1000).toFixed(1)}s`);
  logger.info("═".repeat(68) + "\n");

  return { rowsProcessed, rowsSkipped, bmfNamed, directMatched, trgmMatched, financialDocs, signals, scoresUpdated, elapsedMs };
}
