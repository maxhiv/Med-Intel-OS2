import { describe, it, expect } from "vitest";
import {
  normalizeName,
  tokenize,
  splitApplicantAliases,
  scoreNameMatch,
  pickBestFacility,
  candidateTokens,
  DEFAULT_MATCH_THRESHOLD,
  type FacilityCandidate,
} from "../src/services/facilityNameMatch";

describe("normalizeName", () => {
  it("lowercases, drops punctuation, expands abbreviations and strips corp suffixes", () => {
    expect(normalizeName("St. Mary's Med. Ctr., Inc.")).toBe(
      "saint marys medical center",
    );
  });

  it("expands common provider-name abbreviations", () => {
    expect(normalizeName("Mt Sinai Hosp")).toBe("mount sinai hospital");
    expect(normalizeName("Univ of Chicago Med Ctr")).toBe(
      "university chicago medical center",
    );
  });

  it("treats '&' as 'and' and removes stopwords", () => {
    expect(normalizeName("Children's Hospital of the Valley & Clinic")).toBe(
      "children hospital valley clinic",
    );
  });

  it("returns empty string for purely punctuation input", () => {
    expect(normalizeName("---")).toBe("");
    expect(normalizeName("")).toBe("");
  });
});

describe("tokenize", () => {
  it("returns normalized tokens of length >= 2", () => {
    expect(tokenize("St. Mary's Medical Ctr")).toEqual([
      "saint",
      "marys",
      "medical",
      "center",
    ]);
  });
});

describe("splitApplicantAliases", () => {
  it("splits on d/b/a, dba, and d.b.a.", () => {
    const out = splitApplicantAliases(
      "Memorial Health Services d/b/a Saint Mary's Medical Center",
    );
    expect(out).toContain("Memorial Health Services");
    expect(out).toContain("Saint Mary's Medical Center");
  });

  it("splits on 'on behalf of' for parent-system filings", () => {
    const out = splitApplicantAliases(
      "Ascension Health on behalf of St Vincent Hospital",
    );
    expect(out).toEqual([
      "Ascension Health",
      "St Vincent Hospital",
    ]);
  });

  it("splits on parenthetical 'formerly' or 'aka'", () => {
    const out = splitApplicantAliases(
      "North Shore Medical Center (formerly Salem Hospital)",
    );
    expect(out).toContain("North Shore Medical Center");
    expect(out).toContain("Salem Hospital");
  });

  it("returns the original string when no alias separator is present", () => {
    expect(splitApplicantAliases("Mercy Hospital")).toEqual(["Mercy Hospital"]);
  });

  it("dedupes case-insensitively", () => {
    const out = splitApplicantAliases("Mercy Hospital dba Mercy Hospital");
    expect(out).toEqual(["Mercy Hospital"]);
  });
});

describe("scoreNameMatch", () => {
  it("returns 1.0 for identical normalized names", () => {
    expect(scoreNameMatch("St. Mary's Hospital", "Saint Marys Hospital")).toBe(1);
  });

  it("scores abbreviation drift above the default threshold", () => {
    const s = scoreNameMatch(
      "St. Mary's Med Ctr",
      "Saint Mary's Medical Center",
    );
    expect(s).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
  });

  it("rewards subset containment for longer canonical names", () => {
    const s = scoreNameMatch(
      "Saint Mary Hospital",
      "Saint Mary Hospital and Medical Center",
    );
    expect(s).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
  });

  it("returns a low score for unrelated facility names", () => {
    const s = scoreNameMatch("Mercy Hospital", "Cleveland Clinic");
    expect(s).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
  });

  it("is symmetric", () => {
    const a = "St Mary Med Ctr";
    const b = "Saint Marys Medical Center";
    expect(scoreNameMatch(a, b)).toBeCloseTo(scoreNameMatch(b, a), 5);
  });
});

describe("pickBestFacility — tricky cases", () => {
  const candidates: FacilityCandidate[] = [
    {
      id: "fac-saintmary",
      name: "Saint Mary's Medical Center",
      doingBusinessAs: null,
      systemName: "Ascension Health",
    },
    {
      id: "fac-mercy",
      name: "Mercy General Hospital",
      doingBusinessAs: "Mercy Sacramento",
      systemName: "Dignity Health",
    },
    {
      id: "fac-vincent",
      name: "Saint Vincent Hospital",
      doingBusinessAs: null,
      systemName: "Ascension Health",
    },
    {
      id: "fac-cleveland",
      name: "Cleveland Clinic Foundation",
      doingBusinessAs: null,
      systemName: null,
    },
  ];

  it("matches DBA filings to the operating-name facility", () => {
    const r = pickBestFacility(
      "Memorial Health Services d/b/a Saint Mary's Medical Center",
      candidates,
    );
    expect(r?.facility.id).toBe("fac-saintmary");
    expect(r?.matchedField).toBe("name");
  });

  it("matches DBA-only candidates via the doing_business_as column", () => {
    const r = pickBestFacility("Mercy Sacramento Hospital", candidates);
    expect(r?.facility.id).toBe("fac-mercy");
    expect(r?.matchedField === "dba" || r?.matchedField === "name").toBe(true);
  });

  it("matches parent-system filings to the system_name column", () => {
    // The applicant string is the parent system only — the operating
    // hospital isn't named, so the only signal is system_name.
    const r = pickBestFacility("Ascension Health Inc.", [
      candidates[0],
      candidates[3],
    ]);
    expect(r?.matchedField).toBe("system");
    expect(r?.facility.id).toBe("fac-saintmary");
  });

  it("resolves 'X on behalf of Y' to Y when Y is the tracked facility", () => {
    const r = pickBestFacility(
      "Ascension Health on behalf of St Vincent Hospital",
      candidates,
    );
    expect(r?.facility.id).toBe("fac-vincent");
  });

  it("handles abbreviation drift (St → Saint, Med Ctr → Medical Center)", () => {
    const r = pickBestFacility("St Mary's Med Ctr", candidates);
    expect(r?.facility.id).toBe("fac-saintmary");
  });

  it("returns null when no candidate clears the threshold", () => {
    const r = pickBestFacility("Some Random Surgery Center LLC", candidates);
    expect(r).toBeNull();
  });

  it("does not over-match a generic word like 'Hospital'", () => {
    const r = pickBestFacility("Community Hospital", candidates);
    // None of the candidates is a 'community hospital' — the lone shared
    // 'hospital' token should not push score above threshold.
    expect(r).toBeNull();
  });

  it("prefers the higher-scoring candidate when several match", () => {
    const r = pickBestFacility("Saint Mary Medical Center", candidates);
    expect(r?.facility.id).toBe("fac-saintmary");
  });

  it("refuses to guess when a bare parent-system name ties across siblings", () => {
    // Two member hospitals of the same system — applicant is just the
    // parent system, so there's no signal to disambiguate. The matcher
    // must return null rather than arbitrarily picking one.
    const siblings: FacilityCandidate[] = [
      {
        id: "fac-a",
        name: "Saint Alpha Hospital",
        doingBusinessAs: null,
        systemName: "Ascension Health",
      },
      {
        id: "fac-b",
        name: "Saint Beta Hospital",
        doingBusinessAs: null,
        systemName: "Ascension Health",
      },
    ];
    const r = pickBestFacility("Ascension Health", siblings);
    expect(r).toBeNull();
  });

  it("is deterministic when scores tie exactly (sorted by facility id)", () => {
    // Identical names on two candidates would otherwise depend on DB row
    // order; the ambiguity guard should reject this.
    const dup: FacilityCandidate[] = [
      { id: "fac-z", name: "Mercy Hospital", doingBusinessAs: null, systemName: null },
      { id: "fac-a", name: "Mercy Hospital", doingBusinessAs: null, systemName: null },
    ];
    const r = pickBestFacility("Mercy Hospital", dup);
    expect(r).toBeNull();
  });
});

describe("candidateTokens", () => {
  it("returns long, distinct tokens sorted by length desc", () => {
    const out = candidateTokens(
      "Memorial Health Services d/b/a Saint Mary's Medical Center",
    );
    expect(out[0].length).toBeGreaterThanOrEqual(out[out.length - 1].length);
    expect(new Set(out).size).toBe(out.length);
    expect(out).toContain("memorial");
    expect(out).toContain("saint");
  });

  it("drops short noise tokens but keeps numerics", () => {
    const out = candidateTokens("HCA Hospital 2024", 4);
    expect(out).not.toContain("hca");
    expect(out).toContain("hospital");
    expect(out).toContain("2024");
  });
});
