/**
 * verticalOrchestrator unit tests — focuses on the pure functions
 * (classifyFacility decision logic, normaliseSignalWeights alias
 * collapsing). The DB-touching seed/persist paths are exercised by the
 * integration suite, not here.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFacility,
  normaliseSignalWeights,
  SYSTEM_VERTICALS,
} from "../src/services/verticals/verticalOrchestrator";
import type { VerticalModule } from "@workspace/db";

// Build a mock VerticalModule[] from the static SYSTEM_VERTICALS catalog
// so we exercise classifyFacility() without hitting the DB.
function mockVerticals(): VerticalModule[] {
  return SYSTEM_VERTICALS.map((v, idx) => ({
    id: `00000000-0000-0000-0000-${String(idx).padStart(12, "0")}`,
    slug: v.slug,
    displayName: v.displayName,
    description: v.description,
    primaryModalities: v.primaryModalities,
    facilityTypeFilter: v.facilityTypeFilter,
    signalWeights: v.signalWeights,
    outreachSequenceId: null,
    reportTemplate: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

describe("classifyFacility()", () => {
  const verticals = mockVerticals();

  it("maps a freestanding imaging center to imaging_center", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
        facilityType: "Imaging Center",
        cahDesignation: false,
        fqhcDesignation: false,
      },
      { allVerticals: verticals },
    );
    expect(result.primaryVerticalSlug).toBe("imaging_center");
    expect(result.allVerticalSlugs).toContain("imaging_center");
  });

  it("maps an ASC facility to asc", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-bbbbbbbbbbbb",
        facilityType: "Ambulatory Surgery Center",
        cahDesignation: false,
        fqhcDesignation: false,
      },
      { allVerticals: verticals },
    );
    // Orthopedic + ASC both list ASC in facility_type_filter — orthopedic
    // is declared first in SYSTEM_VERTICALS, so the primary skews to it.
    // Either is correct; the test asserts ASC is at least in the set.
    expect(result.allVerticalSlugs).toContain("asc");
  });

  it("routes a CAH to rural_hospital regardless of facility_type", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-cccccccccccc",
        facilityType: "Hospital", // generic hospital
        cahDesignation: true,
        fqhcDesignation: false,
      },
      { allVerticals: verticals },
    );
    expect(result.allVerticalSlugs).toContain("rural_hospital");
  });

  it("routes an FQHC to rural_hospital as a community-care proxy", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-dddddddddddd",
        facilityType: "FQHC",
        cahDesignation: false,
        fqhcDesignation: true,
      },
      { allVerticals: verticals },
    );
    expect(result.allVerticalSlugs).toContain("rural_hospital");
  });

  it("returns no assignment when nothing matches", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-eeeeeeeeeeee",
        facilityType: "Dialysis Center",
        cahDesignation: false,
        fqhcDesignation: false,
      },
      { allVerticals: verticals },
    );
    expect(result.primaryVerticalSlug).toBeNull();
    expect(result.allVerticalSlugs).toHaveLength(0);
  });

  it("maps a veterinary teaching hospital to veterinary", async () => {
    const result = await classifyFacility(
      {
        id: "00000000-0000-0000-0000-ffffffffffff",
        facilityType: "Veterinary Teaching",
        cahDesignation: false,
        fqhcDesignation: false,
      },
      { allVerticals: verticals },
    );
    expect(result.primaryVerticalSlug).toBe("veterinary");
  });
});

describe("normaliseSignalWeights()", () => {
  it("maps handoff-style aliases into our signal_type enum keys", () => {
    const out = normaliseSignalWeights({
      manufacturer_eol: 0.88,
      acr_iac_expiry: 0.9,
      con_filing: 0.95,
      fda_recall: 0.85,
      hcris_depreciation: 0.75,
    });
    expect(out.eol_equipment).toBe(0.88);
    expect(out.accreditation_renewal).toBe(0.9);
    expect(out.con_filed).toBe(0.95);
    expect(out.adverse_event_spike).toBe(0.85);
    expect(out.hcris_depreciation_spike).toBe(0.75);
  });

  it("collapses multiple aliases into the same enum key by keeping the max", () => {
    const out = normaliseSignalWeights({
      acr_iac_expiry: 0.9,
      aaahc_aaaasf_expiry: 0.85,
      aaha_accreditation_expiry: 0.7,
    });
    // All three collapse to accreditation_renewal; max wins.
    expect(out.accreditation_renewal).toBe(0.9);
  });

  it("preserves keys that already match the enum", () => {
    const out = normaliseSignalWeights({
      job_posting: 0.65,
      leadership_change: 0.7,
    });
    expect(out.job_posting).toBe(0.65);
    expect(out.leadership_change).toBe(0.7);
  });

  it("returns empty for malformed input", () => {
    expect(normaliseSignalWeights(null)).toEqual({});
    expect(normaliseSignalWeights(undefined)).toEqual({});
    expect(normaliseSignalWeights("not an object")).toEqual({});
  });
});
