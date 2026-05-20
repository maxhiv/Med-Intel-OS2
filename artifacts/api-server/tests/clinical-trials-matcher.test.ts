/**
 * Regression tests for the token-overlap facility matcher in
 * `services/clinicalTrialsIngestor.ts`. Previously the matcher did a
 * substring `includes()` check that produced false positives like
 * "Children's Hospital Boston" matching "Boston Medical Center".
 *
 * These tests pin the post-fix behaviour:
 *   - True match: at least 3 shared non-stopword tokens (or all of the
 *     shorter side's tokens, whichever is fewer)
 *   - State agreement required when both sides report a state
 *   - Substring-only overlap on stopwords ("hospital", "medical",
 *     "center") no longer matches.
 */
import { describe, it, expect } from "vitest";
import { studyMatchesFacility } from "../src/services/clinicalTrialsIngestor";
import type { Facility } from "@workspace/db";

function makeFacility(name: string, state: string | null = "MA"): Facility {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    name,
    state,
    facilityType: "Hospital",
    npi: "1000000000",
    doingBusinessAs: null,
    cmsId: null,
    beds: null,
    ownership: null,
    systemName: null,
    idnId: null,
    address1: null,
    city: null,
    zip: null,
    county: null,
    lat: null,
    lng: null,
    website: null,
    cahDesignation: false,
    dshPct: null,
    scpDesignation: false,
    fqhcDesignation: false,
    teachingHospital: false,
    gmeSlots: null,
    parentSystemId: null,
    ein: null,
    operatesHospital: false,
    fiscalYearEndMonth: null,
    fiscalYearEndSource: null,
    signalScore: 0,
    lastScrapedAt: null,
    lastEnrichedAt: null,
    scrapeErrors: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Facility;
}

// Minimal CtStudy stub — only the shape studyMatchesFacility actually reads.
function makeStudy(locations: Array<{ facility?: string; state?: string }>) {
  return {
    protocolSection: { contactsLocationsModule: { locations } },
  } as Parameters<typeof studyMatchesFacility>[0];
}

describe("studyMatchesFacility — token-overlap matcher", () => {
  it("matches exact same-name facility in same state", () => {
    const f = makeFacility("Mayo Clinic Rochester", "MN");
    const s = makeStudy([{ facility: "Mayo Clinic Rochester", state: "MN" }]);
    expect(studyMatchesFacility(s, f)).toBe(true);
  });

  it("matches when shared non-stopword tokens overlap (Mayo Clinic <-> Mayo Clinic Hospital Rochester)", () => {
    const f = makeFacility("Mayo Clinic", "MN");
    const s = makeStudy([{ facility: "Mayo Clinic Hospital Rochester", state: "MN" }]);
    expect(studyMatchesFacility(s, f)).toBe(true);
  });

  it("does NOT match on a single shared distinguishing token (the old substring-overlap bug)", () => {
    // Previously: substring `includes()` would treat "Boston" as matching
    // every Boston-area facility. Token-overlap with MIN_SHARED_TOKENS=2
    // rejects "Boston Medical Center" ↔ "Children's Hospital Boston" because
    // only one non-stopword token agrees ("boston").
    const f = makeFacility("Boston Medical Center", "MA");
    const s = makeStudy([{ facility: "Children's Hospital Boston", state: "MA" }]);
    expect(studyMatchesFacility(s, f)).toBe(false);
  });

  it("rejects matches when state disagrees", () => {
    const f = makeFacility("Mayo Clinic Rochester", "MN");
    const s = makeStudy([{ facility: "Mayo Clinic Rochester", state: "NY" }]);
    expect(studyMatchesFacility(s, f)).toBe(false);
  });

  it("ignores stopword-only overlap (hospital/medical/center/system/etc.)", () => {
    const f = makeFacility("Yale New Haven Hospital", "CT");
    const s = makeStudy([{ facility: "Hartford Medical Hospital Center", state: "CT" }]);
    // After stopword strip: {"yale", "new", "haven"} vs {"hartford"} — zero overlap.
    expect(studyMatchesFacility(s, f)).toBe(false);
  });

  it("returns false when the study has no locations", () => {
    const f = makeFacility("Mayo Clinic Rochester", "MN");
    const s = makeStudy([]);
    expect(studyMatchesFacility(s, f)).toBe(false);
  });

  it("allows match when one side has no state field (best-effort fallback)", () => {
    const f = makeFacility("Massachusetts General Hospital", "MA");
    const s = makeStudy([{ facility: "Massachusetts General Hospital" /* no state */ }]);
    expect(studyMatchesFacility(s, f)).toBe(true);
  });
});
