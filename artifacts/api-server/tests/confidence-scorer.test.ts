/**
 * ConfidenceScorer unit tests — exercises the verified / provisional /
 * contradicted / unknown status logic and the per-claim-field half-life
 * overrides. The ClaimRegistry is mocked so the test stays offline.
 */
import { describe, it, expect } from "vitest";
import { ConfidenceScorer, halfLifeFor, type ClaimStatus } from "../src/services/confidence/confidenceScorer";
import type { ClaimRegistry } from "../src/services/confidence/claimRegistry";

type ClaimRow = {
  claimValue: string;
  sources: string[];
  sourceCount: number;
  summedWeight: number;
  confidence: number;
  lastObservedAt: Date | null;
};

function mockRegistry(rows: ClaimRow[]): ClaimRegistry {
  // Only the methods ConfidenceScorer.assess() touches.
  return {
    getClaimsForField: async () => rows,
  } as unknown as ClaimRegistry;
}

describe("ConfidenceScorer.assess()", () => {
  it("returns unknown when no claims exist", async () => {
    const scorer = new ConfidenceScorer(mockRegistry([]));
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("unknown");
    expect(result.bestValue).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("marks a single-source claim as provisional, no matter how strong the source", async () => {
    const scorer = new ConfidenceScorer(
      mockRegistry([
        {
          claimValue: "2017",
          sources: ["state_radiation_registry"],
          sourceCount: 1,
          summedWeight: 0.95,
          confidence: 0.95,
          lastObservedAt: new Date(),
        },
      ]),
    );
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("provisional");
    expect(result.bestValue).toBe("2017");
    expect(result.sourceCount).toBe(1);
  });

  it("marks a two-source agreeing claim as verified when summed confidence >= 0.6", async () => {
    const scorer = new ConfidenceScorer(
      mockRegistry([
        {
          claimValue: "2017",
          sources: ["state_radiation_registry", "manufacturer_eol_bulletin"],
          sourceCount: 2,
          summedWeight: 1.75,
          confidence: 0.97,
          lastObservedAt: new Date(),
        },
      ]),
    );
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("verified");
    expect(result.sourceCount).toBe(2);
  });

  it("downgrades to provisional when two sources agree but confidence is below 0.6", async () => {
    const scorer = new ConfidenceScorer(
      mockRegistry([
        {
          claimValue: "2017",
          sources: ["job_posting_single", "linkedin_profile"],
          sourceCount: 2,
          summedWeight: 0.55, // sum below the 0.6 floor
          confidence: 0.55,
          lastObservedAt: new Date(),
        },
      ]),
    );
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("provisional");
  });

  it("marks the winner as contradicted when a competing claim crosses 0.3 and the winner is below 0.6", async () => {
    const scorer = new ConfidenceScorer(
      mockRegistry([
        {
          claimValue: "2017",
          sources: ["hospital_press_release"],
          sourceCount: 1,
          summedWeight: 0.55,
          confidence: 0.55,
          lastObservedAt: new Date(),
        },
        {
          claimValue: "2015",
          sources: ["state_radiation_registry"],
          sourceCount: 1,
          summedWeight: 0.45, // < winner BUT >= 0.3 threshold
          confidence: 0.45,
          lastObservedAt: new Date(),
        },
      ]),
    );
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("contradicted");
    expect(result.bestValue).toBe("2017"); // still report the winner
    expect(result.competing).toHaveLength(1);
    expect(result.competing[0].value).toBe("2015");
  });

  it("still reports verified when a competing claim exists but the winner clears 0.6", async () => {
    const scorer = new ConfidenceScorer(
      mockRegistry([
        {
          claimValue: "2017",
          sources: ["state_radiation_registry", "manufacturer_eol_bulletin"],
          sourceCount: 2,
          summedWeight: 1.4,
          confidence: 0.85,
          lastObservedAt: new Date(),
        },
        {
          claimValue: "2015",
          sources: ["hospital_press_release"],
          sourceCount: 1,
          summedWeight: 0.4,
          confidence: 0.4,
          lastObservedAt: new Date(),
        },
      ]),
    );
    const result = await scorer.assess("equipment_records", "00000000-0000-0000-0000-000000000000", "install_year");
    expect(result.status).toBe<ClaimStatus>("verified");
    expect(result.competing).toHaveLength(1);
  });
});

describe("halfLifeFor()", () => {
  it("returns 90 days for contact PII fields", () => {
    expect(halfLifeFor("facility_contacts", "email")).toBe(90);
    expect(halfLifeFor("facility_contacts", "phone")).toBe(90);
    expect(halfLifeFor("facility_contacts", "title")).toBe(90);
  });

  it("returns 365 days for equipment install_year (slow decay)", () => {
    expect(halfLifeFor("equipment_records", "install_year")).toBe(365);
  });

  it("returns 180 days as default for any other field", () => {
    expect(halfLifeFor("facilities", "beds")).toBe(180);
    expect(halfLifeFor("opportunities", "readiness_score")).toBe(180);
  });
});
