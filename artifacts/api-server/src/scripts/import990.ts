/**
 * IRS EO 990 Complete Extract Importer  (Task #103)
 *
 * Phase 1 — CSV import   : Streams the 247MB ZIP, upserts all 246 columns
 *                          into irs_990_raw in 500-row batches.
 *                          Progress logged every 10k rows.
 * Phase 2 — EIN match    : Direct JOIN on facilities.ein (backfilled from
 *                          prior propublica signals). Updates facility_id,
 *                          match_score=1.000, matched_at on irs_990_raw.
 * Phase 3 — Trgm match   : pg_trgm similarity pass for any unmatched rows.
 *                          Threshold 0.45 general, 0.35 for hospital rows.
 *                          NOTE: IRS 990 extract CSV has no org name column;
 *                          this pass is a structural placeholder — actual
 *                          name-based matching requires the IRS EO BMF file
 *                          (Task #104). Logged clearly.
 * Phase 4 — Fin docs     : Upsert financial_documents per spec mapping:
 *                          capitalExpenditures = deprcatndepletn,
 *                          operatingIncome = totrevenue - totfuncexpns,
 *                          netPatientRevenue = totprgmrevnue.
 * Phase 5 — Signals      : Emit 4 signal types per spec thresholds.
 * Phase 6 — Score recomp : recomputeAllScores() for all facilities.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run import-990
 *
 * Env overrides:
 *   IRS_990_ZIP_PATH      Absolute path to ZIP (default: attached_assets/)
 *   IRS_990_BATCH_SIZE    Rows per DB batch      (default: 500)
 *   IRS_990_SIGNALS_ONLY  "1" → skip CSV import, run phases 2-6 only
 */

export {};

import path from "node:path";
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import { parse } from "csv-parse";
import { getTableColumns, sql } from "drizzle-orm";
import { db, irs990Raw } from "@workspace/db";
import { recomputeOne } from "../services/signalScorer";

// ─── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT    = path.resolve(import.meta.dirname, "../../../../");
const DEFAULT_ZIP  = path.join(
  REPO_ROOT,
  "attached_assets/24eoextract990_1778864725332.zip",
);
const ZIP_PATH     = process.env.IRS_990_ZIP_PATH ?? DEFAULT_ZIP;
const BATCH_SIZE   = Math.max(100, Number(process.env.IRS_990_BATCH_SIZE ?? 500));
const SIGNALS_ONLY = process.env.IRS_990_SIGNALS_ONLY === "1";

// Signal thresholds — exact per task spec
const FINANCIAL_HEALTH_MIN_REVENUE  = 1_000_000;  // totrevenue > $1M
const CAPITAL_INVESTMENT_MIN_EQUIP  = 500_000;    // lndbldgsequipend > $500k
const WORKFORCE_MIN_EMPLOYEES       = 50;          // noemplyeesw3cnt > 50
const WORKFORCE_MIN_OFFICER_COMP    = 100_000;    // compnsatncurrofcr > $100k

// pg_trgm thresholds — per task spec
const TRGM_THRESHOLD_GENERAL  = 0.45;
const TRGM_THRESHOLD_HOSPITAL = 0.35;

function fmt(n: number) { return n.toLocaleString("en-US"); }

// ─── Raw-SQL batch helpers (bypass 65,535-parameter prepared-stmt limit) ─────

const _allCols    = getTableColumns(irs990Raw);
const _colNames   = Object.values(_allCols).map(c => `"${c.name}"`).join(", ");
const _colKeys    = Object.keys(_allCols) as Array<keyof typeof _allCols>;

// ON CONFLICT SET clause — all cols except PK; updatedAt stamps now()
const _conflictSet = Object.entries(_allCols)
  .filter(([k]) => k !== "ein" && k !== "ingestedAt")
  .map(([k, col]) =>
    k === "updatedAt"
      ? `"${col.name}" = now()`
      : `"${col.name}" = excluded."${col.name}"`,
  )
  .join(", ");

/** Safe SQL literal formatter — no user input reaches this. */
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

// ─── CSV → typed row ──────────────────────────────────────────────────────────

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

    // Part IV — Checklist flags
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

    // Part V — Compliance counts & flags
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

    // Part V — Amounts
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

    // Part VII — Compensation
    totreprtabled: toBigint(rec["totreprtabled"]),
    totcomprelatede: toBigint(rec["totcomprelatede"]),
    totestcompf: toBigint(rec["totestcompf"]),
    noindiv100kcnt: toInt(rec["noindiv100kcnt"]),
    nocontractor100kcnt: toInt(rec["nocontractor100kcnt"]),

    // Part VIII — Revenue
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

    // Part IX — Expenses
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

    // Part X — Balance Sheet
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

    // Schedule A — Public Support
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

// ─── Phase 1: Stream CSV → irs_990_raw ───────────────────────────────────────

async function flushBatch(rawBatch: IrsRow[]): Promise<void> {
  if (!rawBatch.length) return;
  // Deduplicate within batch: keep latest tax_pd per EIN
  const seen = new Map<string, IrsRow>();
  for (const row of rawBatch) {
    const existing = seen.get(row.ein!);
    if (!existing || (String(row.taxPd ?? "") > String(existing.taxPd ?? ""))) {
      seen.set(row.ein!, row);
    }
  }
  const deduped = Array.from(seen.values());
  // Raw-SQL literal insert — avoids the 65,535-parameter prepared-stmt limit.
  // Each value is inline-formatted; no user data ever reaches this code path.
  const valuesSql = deduped
    .map(row => `(${_colKeys.map(k => sqlLit(row[k])).join(", ")})`)
    .join(",\n");
  await db.execute(sql.raw(
    `INSERT INTO irs_990_raw (${_colNames}) VALUES ${valuesSql}
     ON CONFLICT (ein) DO UPDATE SET ${_conflictSet}`,
  ));
}

async function importCsv(): Promise<{ rowsProcessed: number; rowsSkipped: number }> {
  return new Promise((resolve, reject) => {
    const csvPath = "/tmp/irs_990_extract.csv";
    console.log(`  Extracting inner CSV from ZIP...`);
    try {
      execSync(
        `python3 -c "
import zipfile
with zipfile.ZipFile('${ZIP_PATH}') as z:
    names=[n for n in z.namelist() if n.endswith('.csv')]
    with z.open(names[0]) as src, open('${csvPath}','wb') as dst:
        while True:
            chunk=src.read(1<<20)
            if not chunk: break
            dst.write(chunk)
"`,
        { stdio: ["inherit", "pipe", "inherit"] },
      );
    } catch (err) {
      return reject(new Error(`ZIP extraction failed: ${String(err)}`));
    }

    console.log(`  Streaming CSV into irs_990_raw (batch=${BATCH_SIZE})...`);

    let rowsProcessed = 0;
    let rowsSkipped   = 0;
    let batch: IrsRow[] = [];
    let flushChain     = Promise.resolve<void>(undefined);
    let lastLogCount   = 0;

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
        if (batch.length >= BATCH_SIZE) {
          const toFlush = batch;
          batch = [];
          flushChain = flushChain.then(() => flushBatch(toFlush));
        }
        if (rowsProcessed - lastLogCount >= 10_000) {
          console.log(`    ... ${fmt(rowsProcessed)} rows processed`);
          lastLogCount = rowsProcessed;
        }
      }
    });

    parser.on("end", async () => {
      if (batch.length > 0) {
        flushChain = flushChain.then(() => flushBatch(batch));
      }
      await flushChain;
      resolve({ rowsProcessed, rowsSkipped });
    });

    parser.on("error", reject);
    createReadStream(csvPath).pipe(parser);
  });
}

// ─── Phase 2: Direct EIN match ────────────────────────────────────────────────

async function directEinMatch(): Promise<number> {
  // Link 990 rows to facilities where EIN already set on facility
  await db.execute(sql.raw(`
    UPDATE irs_990_raw i
    SET facility_id = f.id,
        match_score = 1.000,
        matched_at  = now()
    FROM facilities f
    WHERE f.ein = i.ein
      AND i.facility_id IS NULL
  `));
  // Return count matched
  const [row] = (await db.execute<{ cnt: string }>(sql.raw(`
    SELECT COUNT(*)::text AS cnt FROM irs_990_raw WHERE facility_id IS NOT NULL
  `))).rows;
  return Number(row.cnt);
}

// ─── Phase 3: pg_trgm name match ─────────────────────────────────────────────

async function trgmMatch(): Promise<number> {
  // The IRS 990 extract CSV contains only financial data keyed by EIN —
  // it has NO organization name column. pg_trgm name-based matching requires
  // the IRS EO Business Master File (BMF), handled separately in Task #104.
  //
  // This pass is implemented as a structural placeholder that respects the
  // thresholds from the task spec (0.45 general, 0.35 hospital). It returns 0
  // because name data is not available in this extract.
  //
  // Threshold constants are preserved here for Task #104 to wire in:
  void TRGM_THRESHOLD_GENERAL;
  void TRGM_THRESHOLD_HOSPITAL;

  const [unmatched] = (await db.execute<{ cnt: string }>(sql.raw(`
    SELECT COUNT(*)::text AS cnt FROM irs_990_raw WHERE facility_id IS NULL
  `))).rows;
  console.log(`    ${fmt(Number(unmatched.cnt))} rows still unmatched after EIN join.`);
  console.log(`    trgm pass: skipped (no name column in IRS 990 extract — see Task #104).`);
  return 0;
}

// ─── Phase 4: Upsert financial_documents ──────────────────────────────────────

async function upsertFinancialDocs(): Promise<number> {
  const result = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO financial_documents (
      facility_id,
      doc_type,
      fiscal_year,
      total_revenue,
      operating_income,
      capital_expenditures,
      long_term_debt,
      net_patient_revenue,
      ingested_at
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

// ─── Phase 5: Emit purchase signals ───────────────────────────────────────────

/**
 * Revenue-decile confidence scaling for financial_health (task spec: 40–95).
 * Approximates deciles from IRS 990 revenue distribution.
 */
function revenueDecileConf(revenue: number): number {
  const deciles = [
    1_000_000,
    2_000_000,
    5_000_000,
    10_000_000,
    25_000_000,
    50_000_000,
    100_000_000,
    250_000_000,
    500_000_000,
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

  // hospital_operator — confidence 90
  const hospRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, is_active, detected_at)
    SELECT
      i.facility_id,
      'hospital_operator',
      'irs_990:hospital:' || i.ein,
      90,
      'irs_990',
      true,
      now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL
      AND i.operatehosptlcd = 'Y'
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  counts["hospital_operator"] = hospRes.rows.length;
  console.log(`    hospital_operator  : ${fmt(hospRes.rows.length)}`);

  // capital_investment — lndbldgsequipend > $500k, confidence 75
  const capRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      i.facility_id,
      'capital_investment',
      'irs_990:capex:' || i.ein,
      75,
      'irs_990',
      jsonb_build_object(
        'lndbldgsequipend', i.lndbldgsequipend,
        'deprcatndepletn',  i.deprcatndepletn,
        'totassetsend',     i.totassetsend
      ),
      true,
      now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL
      AND i.lndbldgsequipend > ${CAPITAL_INVESTMENT_MIN_EQUIP}
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  counts["capital_investment"] = capRes.rows.length;
  console.log(`    capital_investment : ${fmt(capRes.rows.length)}`);

  // workforce_expansion — >50 employees AND officer comp > $100k, confidence 65
  const workRes = await db.execute<{ id: string }>(sql.raw(`
    INSERT INTO purchase_signals
      (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      i.facility_id,
      'workforce_expansion',
      'irs_990:workforce:' || i.ein,
      65,
      'irs_990',
      jsonb_build_object(
        'noemplyeesw3cnt',  i.noemplyeesw3cnt,
        'compnsatncurrofcr', i.compnsatncurrofcr
      ),
      true,
      now()
    FROM irs_990_raw i
    WHERE i.facility_id IS NOT NULL
      AND i.noemplyeesw3cnt > ${WORKFORCE_MIN_EMPLOYEES}
      AND i.compnsatncurrofcr > ${WORKFORCE_MIN_OFFICER_COMP}
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  counts["workforce_expansion"] = workRes.rows.length;
  console.log(`    workforce_expansion: ${fmt(workRes.rows.length)}`);

  // financial_health — totrevenue > $1M, confidence decile-scaled 40–95
  const healthRows = await db.execute<{
    facility_id: string;
    ein: string;
    totrevenue: string;
    totnetassetend: string | null;
    totliabend: string | null;
  }>(sql.raw(`
    SELECT facility_id, ein, totrevenue, totnetassetend, totliabend
    FROM irs_990_raw
    WHERE facility_id IS NOT NULL
      AND totrevenue > ${FINANCIAL_HEALTH_MIN_REVENUE}
  `));

  let healthCount = 0;
  // Batch in groups of 500 for efficiency
  const healthBatch = healthRows.rows;
  for (let i = 0; i < healthBatch.length; i += 500) {
    const chunk = healthBatch.slice(i, i + 500);
    for (const r of chunk) {
      const rev  = Number(r.totrevenue ?? 0);
      const conf = revenueDecileConf(rev);
      const meta = JSON.stringify({
        totrevenue:     r.totrevenue    ?? null,
        totnetassetend: r.totnetassetend ?? null,
        totliabend:     r.totliabend    ?? null,
      });
      await db.execute(sql.raw(`
        INSERT INTO purchase_signals
          (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
        VALUES (
          '${r.facility_id}',
          'financial_health',
          'irs_990:health:${r.ein}',
          ${conf},
          'irs_990',
          '${meta.replace(/'/g, "''")}',
          true,
          now()
        )
        ON CONFLICT DO NOTHING
      `));
      healthCount++;
    }
  }
  counts["financial_health"] = healthCount;
  console.log(`    financial_health   : ${fmt(healthCount)}`);

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { total, byType: counts };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(68));
console.log("  MedIntel OS — IRS 990 Complete Extract Importer");
console.log(`  ZIP        : ${ZIP_PATH}`);
console.log(`  Batch size : ${fmt(BATCH_SIZE)}`);
console.log(`  Mode       : ${SIGNALS_ONLY ? "SIGNALS_ONLY (skip CSV import)" : "FULL"}`);
console.log("═".repeat(68) + "\n");

await db.execute(sql`SELECT 1`).catch((err) => {
  console.error("DB connection failed:", String(err));
  process.exit(1);
});
console.log("  DB connected.\n");

const t0 = Date.now();

// Phase 1
if (!SIGNALS_ONLY) {
  console.log("  [1/6] Streaming CSV into irs_990_raw...");
  const { rowsProcessed, rowsSkipped } = await importCsv();
  console.log(`  Done: ${fmt(rowsProcessed)} rows ingested, ${fmt(rowsSkipped)} skipped.\n`);
} else {
  console.log("  [1/6] Skipping CSV import (SIGNALS_ONLY=1).\n");
}

// Phase 2 stats
const [raw] = (await db.execute<{ total: string; hospitals: string }>(sql.raw(`
  SELECT
    COUNT(*)::text                                    AS total,
    COUNT(*) FILTER (WHERE operatehosptlcd='Y')::text AS hospitals
  FROM irs_990_raw
`))).rows;
console.log(`  [2/6] irs_990_raw: ${fmt(Number(raw.total))} rows, ${fmt(Number(raw.hospitals))} hospitals`);

// Phase 3: direct EIN match
console.log("\n  [3/6] Direct EIN match (facilities.ein → irs_990_raw.ein)...");
const totalMatched = await directEinMatch();
console.log(`  Total matched: ${fmt(totalMatched)} rows linked to a facility.`);

// Phase 4: trgm pass
console.log("\n  [4/6] pg_trgm name match pass...");
const trgmMatched = await trgmMatch();
console.log(`  trgm matched: ${fmt(trgmMatched)} additional facilities.`);

// Phase 5: financial_documents
console.log("\n  [5/6] Upserting financial_documents...");
const fdCount = await upsertFinancialDocs();
console.log(`  Upserted ${fmt(fdCount)} financial_documents rows.`);

// Phase 6: signals
console.log("\n  [6/6] Emitting purchase signals...");
const { total: signalTotal } = await emitSignals();
console.log(`\n  Total signals emitted: ${fmt(signalTotal)}`);

// Score recomputation — only for facilities matched to 990 data
console.log("\n  Recomputing scores for matched facilities...");
const matchedIds = (await db.execute<{ facility_id: string }>(sql.raw(`
  SELECT DISTINCT facility_id FROM irs_990_raw WHERE facility_id IS NOT NULL
`))).rows;
let updated = 0;
for (const row of matchedIds) {
  await recomputeOne(row.facility_id);
  updated++;
}
console.log(`  Scores updated for ${fmt(updated)} facilities.`);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  Summary: ${fmt(Number(raw.total))} EINs | ${fmt(totalMatched)} matched | ${fmt(signalTotal)} signals | ${elapsed}s`);
console.log("═".repeat(68) + "\n");
process.exit(0);
