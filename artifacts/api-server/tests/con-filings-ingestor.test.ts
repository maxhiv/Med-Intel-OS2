/**
 * Unit + integration tests for the CON filings ingestor (task #23).
 *
 * Unit tests cover the pure helpers (parseRssItems, extractApplicant,
 * inferModality, looksApproved) so the seven state adapters keep producing
 * sensible RawFilings as the parsing logic evolves.
 *
 * The integration test runs `ingestConFilings` against an in-memory stub
 * adapter so it exercises the dedupe + signal-emission path against the real
 * database without touching the network.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  conFilings,
  db,
  facilities,
  purchaseSignals,
} from "@workspace/db";
import {
  extractApplicant,
  inferModality,
  ingestConFilings,
  looksApproved,
  parseRssItems,
  type RawFiling,
} from "../src/services/conFilingsIngestor";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseRssItems", () => {
  it("extracts title/link/pubDate/description from RSS 2.0 items", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Saint Mary's Hospital — CON #24-001 — MRI replacement</title>
        <link>https://example.test/filings/24-001</link>
        <pubDate>Mon, 01 Apr 2024 12:00:00 GMT</pubDate>
        <description>Replacement MRI scanner</description>
      </item>
      <item>
        <title>General Hospital — CT addition</title>
        <link>https://example.test/filings/24-002</link>
      </item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe(
      "Saint Mary's Hospital — CON #24-001 — MRI replacement",
    );
    expect(items[0].link).toBe("https://example.test/filings/24-001");
    expect(items[0].pubDate).toBe("Mon, 01 Apr 2024 12:00:00 GMT");
    expect(items[0].description).toBe("Replacement MRI scanner");
    expect(items[1].link).toBe("https://example.test/filings/24-002");
    expect(items[1].description).toBe("");
  });

  it("extracts Atom entries with href links and updated/published dates", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Acme Surgical — Approval issued</title>
        <link href="https://example.test/decisions/9001" rel="alternate"/>
        <updated>2024-05-01T00:00:00Z</updated>
        <summary>Decision: approval granted.</summary>
      </entry>
    </feed>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe("https://example.test/decisions/9001");
    expect(items[0].pubDate).toBe("2024-05-01T00:00:00Z");
    expect(items[0].description).toBe("Decision: approval granted.");
  });

  it("skips items missing a title or link", () => {
    const xml = `<rss><channel>
      <item><title>No link here</title></item>
      <item><link>https://example.test/no-title</link></item>
      <item><title>Good</title><link>https://example.test/ok</link></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items.map((i) => i.link)).toEqual(["https://example.test/ok"]);
  });

  it("returns [] for non-RSS payloads", () => {
    expect(parseRssItems("not xml")).toEqual([]);
    expect(parseRssItems("")).toEqual([]);
  });
});

describe("extractApplicant", () => {
  it("takes the segment before the first em/en-dash separator", () => {
    expect(
      extractApplicant("Saint Mary's Hospital — CON #24-001 — MRI replacement"),
    ).toBe("Saint Mary's Hospital");
    expect(extractApplicant("General Hospital – CT addition")).toBe(
      "General Hospital",
    );
  });

  it("splits on hyphen-with-spaces and `: ` separators", () => {
    expect(extractApplicant("Acme Surgical - Approval issued")).toBe(
      "Acme Surgical",
    );
    expect(extractApplicant("Mercy Health: new linear accelerator")).toBe(
      "Mercy Health",
    );
  });

  it("returns the trimmed full title when no separator is present", () => {
    expect(extractApplicant("  Riverside Clinic  ")).toBe("Riverside Clinic");
  });

  it("caps the result at 250 chars", () => {
    const long = "A".repeat(400);
    expect(extractApplicant(long).length).toBe(250);
  });
});

describe("inferModality", () => {
  it.each([
    ["MRI replacement scanner", "MRI"],
    ["new magnetic resonance imaging", "MRI"],
    ["adding a CT room", "CT"],
    ["computed tomography upgrade", "CT"],
    ["PET scanner", "PET"],
    ["positron emission tomography", "PET"],
    ["SPECT camera", "SPECT"],
    ["linear accelerator replacement", "LINAC"],
    ["LINAC vault expansion", "LINAC"],
    ["mammography unit", "MAMMO"],
    ["ultrasound suite", "US"],
    ["x-ray room", "XRAY"],
    ["xray room", "XRAY"],
    ["cardiac cath lab", "CATH"],
  ])("%s -> %s", (input, expected) => {
    expect(inferModality(input)).toBe(expected);
  });

  it("returns undefined when nothing matches or input is empty", () => {
    expect(inferModality("general hospital expansion")).toBeUndefined();
    expect(inferModality("")).toBeUndefined();
    expect(inferModality(null)).toBeUndefined();
    expect(inferModality(undefined)).toBeUndefined();
  });

  it("matches case-insensitively but respects word boundaries", () => {
    // 'mri' embedded in another word should NOT match because of \bMRI\b.
    expect(inferModality("submrint")).toBeUndefined();
    expect(inferModality("Mri suite")).toBe("MRI");
  });
});

describe("looksApproved", () => {
  it("matches approval-ish status strings", () => {
    expect(looksApproved("Approved")).toBe(true);
    expect(looksApproved("approval issued")).toBe(true);
    expect(looksApproved("Granted")).toBe(true);
    expect(looksApproved("grant")).toBe(true);
    expect(looksApproved("Permit issued")).toBe(true);
  });

  it("returns false for non-approval / empty inputs", () => {
    expect(looksApproved("filed")).toBe(false);
    expect(looksApproved("under review")).toBe(false);
    expect(looksApproved("pending")).toBe(false);
    expect(looksApproved("")).toBe(false);
    expect(looksApproved(null)).toBe(false);
    expect(looksApproved(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: ingestConFilings against a stub adapter
// ---------------------------------------------------------------------------

describe("ingestConFilings (stub adapter, real DB)", () => {
  const tag = randomUUID().slice(0, 8);
  const facilityName = `Test Mercy Hospital ${tag}`;
  const otherUrl = `https://example.test/filings/${tag}/other`;
  const matchedUrl = `https://example.test/filings/${tag}/matched`;
  const approvedUrl = `https://example.test/filings/${tag}/approved`;
  let facilityId: string;

  beforeAll(async () => {
    const [f] = await db
      .insert(facilities)
      .values({
        npi: String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
        name: facilityName,
        facilityType: "hospital",
        state: "ZZ",
        city: "Testville",
        signalScore: 0,
      })
      .returning({ id: facilities.id });
    facilityId = f.id;
  });

  afterAll(async () => {
    // Children before parents: signals -> con_filings -> facility.
    await db
      .delete(purchaseSignals)
      .where(eq(purchaseSignals.facilityId, facilityId));
    await db
      .delete(conFilings)
      .where(
        and(
          eq(conFilings.state, "ZZ"),
          inArray(conFilings.filingUrl, [matchedUrl, approvedUrl, otherUrl]),
        ),
      );
    await db.delete(facilities).where(eq(facilities.id, facilityId));
  });

  function stubAdapter(filings: RawFiling[]) {
    return {
      state: "ZZ",
      fetch: async () => filings,
    };
  }

  it("inserts new filings, links matched facility, emits con_filed signal, and dedupes on re-run", async () => {
    const filings: RawFiling[] = [
      // Will match the seeded facility by name + state.
      {
        state: "ZZ",
        filingUrl: matchedUrl,
        applicantName: facilityName,
        rawStatus: "filed",
        approved: false,
        modality: "MRI",
      },
      // Same filingUrl repeated WITHIN the run — second copy must be skipped
      // by the (state, url) idempotency check.
      {
        state: "ZZ",
        filingUrl: matchedUrl,
        applicantName: facilityName,
        rawStatus: "filed",
        approved: false,
      },
      // No matching facility → inserts the filing but emits no signal.
      {
        state: "ZZ",
        filingUrl: otherUrl,
        applicantName: `Nonexistent Facility ${tag}`,
        rawStatus: "filed",
        approved: false,
      },
      // Skipped entirely (missing required fields).
      {
        state: "ZZ",
        filingUrl: "",
        applicantName: "ignored",
      },
    ];

    const r1 = await ingestConFilings({ adapters: [stubAdapter(filings)] });

    expect(r1.adaptersRun).toBe(1);
    expect(r1.filingsFetched).toBe(4);
    // The matched filing inserts once; the duplicate URL inside the same run
    // is skipped; the unmatched filing inserts; the empty-URL row is skipped.
    expect(r1.filingsInserted).toBe(2);
    expect(r1.facilitiesLinked).toBe(1);
    expect(r1.signalsInserted).toBe(1);
    expect(r1.errors).toBe(0);
    expect(r1.perState.ZZ).toEqual({
      fetched: 4,
      inserted: 2,
      signals: 1,
      errors: 0,
    });

    const filed = await db
      .select()
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, facilityId),
          eq(purchaseSignals.signalType, "con_filed"),
          eq(purchaseSignals.signalValue, matchedUrl),
        ),
      );
    expect(filed).toHaveLength(1);
    expect(filed[0].confidence).toBe(75);
    expect(filed[0].source).toBe("con_filing");

    // ---- Second run: same filings → must be a no-op (cross-run dedupe).
    const r2 = await ingestConFilings({ adapters: [stubAdapter(filings)] });
    expect(r2.filingsInserted).toBe(0);
    expect(r2.signalsInserted).toBe(0);
    // Existing-row check short-circuits before facility resolution, so a
    // pure no-op run reports zero links — confirms we don't waste lookups.
    expect(r2.facilitiesLinked).toBe(0);

    // ---- Third run: an APPROVED filing for the same facility at a NEW URL.
    // Must insert and emit a `con_approved` signal with confidence=90.
    const r3 = await ingestConFilings({
      adapters: [
        stubAdapter([
          {
            state: "ZZ",
            filingUrl: approvedUrl,
            applicantName: facilityName,
            rawStatus: "approved",
            approved: true,
          },
        ]),
      ],
    });
    expect(r3.filingsInserted).toBe(1);
    expect(r3.signalsInserted).toBe(1);

    const approved = await db
      .select()
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, facilityId),
          eq(purchaseSignals.signalType, "con_approved"),
          eq(purchaseSignals.signalValue, approvedUrl),
        ),
      );
    expect(approved).toHaveLength(1);
    expect(approved[0].confidence).toBe(90);
  });

  it("counts adapter throws as errors and continues with the next adapter", async () => {
    const throwing = {
      state: "ZZ",
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const r = await ingestConFilings({ adapters: [throwing] });
    expect(r.adaptersRun).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.filingsFetched).toBe(0);
    expect(r.perState.ZZ.errors).toBe(1);
  });
});
