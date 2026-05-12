/**
 * Facility name matching for CON-applicant resolution.
 *
 * The CON ingestor receives free-text applicant names off state portals and
 * must map them to a tracked `facilities` row. A naive `ilike '%name%'` misses
 * three common shapes:
 *
 *   1. DBA filings ("Memorial Health Services d/b/a Saint Mary's Medical
 *      Center") where the legal applicant differs from the operating name.
 *   2. Parent-system filings ("Ascension Health" filing on behalf of a member
 *      hospital) where only the system name matches.
 *   3. Abbreviation drift ("St. Mary's Med Ctr" vs "Saint Mary's Medical
 *      Center") where the strings differ token-by-token but mean the same
 *      facility.
 *
 * This module exposes a small, dependency-free toolkit for those cases:
 *
 *   - `normalizeName` — lowercase, strip punctuation, drop corp suffixes and
 *     stopwords, expand common abbreviations.
 *   - `tokenize` — normalized whitespace-split tokens (length >= 2).
 *   - `splitApplicantAliases` — pulls `… d/b/a …`, `… dba …`, `… (formerly …)`
 *     and `… on behalf of …` apart so each side is matched independently.
 *   - `scoreNameMatch` — symmetric similarity in [0, 1] combining token
 *     Jaccard with character-trigram Sørensen-Dice.
 *   - `pickBestFacility` — given an applicant string and a candidate list,
 *     returns the highest-scoring facility above `threshold` along with the
 *     score and which column matched (`name` | `dba` | `system`).
 *
 * The scoring is deterministic and pure so the tricky-case behaviour can be
 * unit tested without standing up the database.
 */

export interface FacilityCandidate {
  id: string;
  name: string;
  doingBusinessAs?: string | null;
  systemName?: string | null;
}

export interface MatchResult {
  facility: FacilityCandidate;
  score: number;
  matchedField: "name" | "dba" | "system";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Corporate / legal suffixes that carry no matching signal. */
const CORP_SUFFIXES = new Set([
  "inc", "incorporated",
  "llc", "llp", "lp", "pa", "pc", "pllc",
  "corp", "corporation", "co", "company",
  "ltd", "limited",
]);

/** English stopwords that appear in facility names but rarely disambiguate. */
const STOPWORDS = new Set(["the", "of", "and", "at", "for", "a", "an"]);

/**
 * Token-level abbreviation expansions. Applied after lowercasing and
 * punctuation stripping so "St." and "St" both collapse to "saint".
 *
 * The map intentionally goes from short → long so equality checks always
 * compare canonical, fully-spelled tokens.
 */
const ABBREVIATIONS: Record<string, string> = {
  st: "saint",
  ste: "saint",
  mt: "mount",
  ft: "fort",
  med: "medical",
  ctr: "center",
  cntr: "center",
  hosp: "hospital",
  hosps: "hospital",
  univ: "university",
  reg: "regional",
  regl: "regional",
  natl: "national",
  intl: "international",
  memrl: "memorial",
  meml: "memorial",
  comm: "community",
  childrens: "children",
  childs: "children",
  hlth: "health",
  svc: "service",
  svcs: "service",
  services: "service",
  hosipital: "hospital", // common typo seen in portal data
};

/**
 * Lowercase, remove punctuation, expand abbreviations and drop corp suffixes
 * + stopwords. Returns a single space-joined string suitable for tokenization
 * or substring tests.
 */
export function normalizeName(input: string): string {
  if (!input) return "";
  // Punctuation → space; collapse possessives like "Mary's" → "marys" first
  // so the trailing 's' is preserved as part of the token.
  const stripped = input
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";

  const out: string[] = [];
  for (const tok of stripped.split(" ")) {
    if (!tok) continue;
    if (CORP_SUFFIXES.has(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    const expanded = ABBREVIATIONS[tok] ?? tok;
    out.push(expanded);
  }
  return out.join(" ");
}

/** Normalized tokens of length >= 2. */
export function tokenize(input: string): string[] {
  return normalizeName(input)
    .split(" ")
    .filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// Alias splitting
// ---------------------------------------------------------------------------

/**
 * Many CON applicants are written as "<legal entity> d/b/a <operating name>"
 * or "<system> on behalf of <hospital>". Each side should be matched
 * independently — the legal entity often matches `system_name` while the
 * operating name matches `name` or `doing_business_as`.
 *
 * Returns a deduped list of trimmed alias strings, original string included.
 */
export function splitApplicantAliases(applicant: string): string[] {
  if (!applicant) return [];
  const splitters = [
    /\s+d\/?b\/?a\.?\s+/i, // dba, d/b/a, d.b.a.
    /\s+a\/?k\/?a\.?\s+/i, // aka, a/k/a
    /\s+f\/?k\/?a\.?\s+/i, // fka, f/k/a
    /\s+on\s+behalf\s+of\s+/i,
    /\s+formerly(?:\s+known\s+as)?\s+/i,
    /\s*\(\s*(?:dba|d\/b\/a|formerly|aka|a\/k\/a)\s+([^)]+)\)\s*/i,
  ];
  let parts: string[] = [applicant];
  for (const re of splitters) {
    const next: string[] = [];
    for (const p of parts) {
      next.push(...p.split(re).filter(Boolean));
    }
    parts = next;
  }
  // Trim, drop empties and dedupe (case-insensitive).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().replace(/\s+/g, " ");
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Sørensen-Dice over character trigrams (similar to PostgreSQL's pg_trgm). */
function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Symmetric similarity in [0, 1].
 *
 * Combines token Jaccard (good for word-level matches across different orders
 * and missing connectors) with character-trigram Dice (good for typos, suffix
 * drift, and abbreviation expansion that survived normalization). The max
 * is taken so either signal can carry a confident match.
 *
 * A small containment bonus is added when one side's tokens are a subset of
 * the other — this catches "Saint Mary's Hospital" matching the longer
 * "Saint Mary's Hospital and Medical Center".
 */
export function scoreNameMatch(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(na.split(" ").filter((t) => t.length >= 2));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 2));
  const tokenScore = jaccard(ta, tb);
  const trigramScore = trigramSim(na, nb);

  // Subset containment bonus: if every meaningful token of the shorter name
  // appears in the longer name, treat it as at least 0.7. This handles
  // "Ascension St Mary" ⊂ "Ascension Saint Mary Medical Center" cleanly.
  let containment = 0;
  if (ta.size > 0 && tb.size > 0) {
    const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let allIn = true;
    for (const t of small) {
      if (!big.has(t)) {
        allIn = false;
        break;
      }
    }
    if (allIn) containment = 0.7 + 0.3 * (small.size / big.size);
  }

  return Math.max(tokenScore, trigramScore, containment);
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/** Default minimum confidence to accept a fuzzy match. */
export const DEFAULT_MATCH_THRESHOLD = 0.6;

/**
 * Required gap between the top weighted score and the runner-up before we
 * trust the winner. Without this, applicant strings like a bare parent
 * system name ("Ascension Health") tie across every member hospital via
 * `system_name` and the matcher would arbitrarily pick the first row.
 */
export const DEFAULT_AMBIGUITY_MARGIN = 0.05;

/**
 * Score every candidate against every alias of the applicant string and
 * return the best overall match above `threshold`, or null. The matched
 * field (`name` | `dba` | `system`) is reported so callers can log which
 * column carried the resolution.
 */
export function pickBestFacility(
  applicant: string,
  candidates: FacilityCandidate[],
  opts: { threshold?: number; ambiguityMargin?: number } = {},
): MatchResult | null {
  const threshold = opts.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const ambiguityMargin = opts.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  const aliases = splitApplicantAliases(applicant);
  if (aliases.length === 0 || candidates.length === 0) return null;

  // Field weights: a hit on the operating `name` is more specific than a hit
  // on `doing_business_as`, which in turn is more specific than `system_name`.
  // Without this, an "Ascension Health on behalf of St Vincent Hospital"
  // applicant ties on every Ascension facility via `system_name` and the
  // operating-name signal ("St Vincent Hospital") gets buried.
  const FIELD_WEIGHT: Record<MatchResult["matchedField"], number> = {
    name: 1.0,
    dba: 0.95,
    system: 0.85,
  };

  // Compute the best (weighted, raw, matchedField) per candidate, then sort
  // and apply the ambiguity guard against the runner-up *facility*.
  type PerCand = { cand: FacilityCandidate; weighted: number; raw: number; matchedField: MatchResult["matchedField"] };
  const perCandidate: PerCand[] = [];
  for (const cand of candidates) {
    const fields: { key: MatchResult["matchedField"]; value: string | null | undefined }[] = [
      { key: "name", value: cand.name },
      { key: "dba", value: cand.doingBusinessAs },
      { key: "system", value: cand.systemName },
    ];
    let candBest: PerCand | null = null;
    for (const alias of aliases) {
      for (const f of fields) {
        if (!f.value) continue;
        const raw = scoreNameMatch(alias, f.value);
        if (raw < threshold) continue;
        const weighted = raw * FIELD_WEIGHT[f.key];
        if (!candBest || weighted > candBest.weighted) {
          candBest = { cand, weighted, raw, matchedField: f.key };
        }
      }
    }
    if (candBest) perCandidate.push(candBest);
  }
  if (perCandidate.length === 0) return null;

  // Deterministic ordering: weighted score desc, then facility id asc so ties
  // never depend on DB row order.
  perCandidate.sort((a, b) => {
    if (b.weighted !== a.weighted) return b.weighted - a.weighted;
    return a.cand.id < b.cand.id ? -1 : a.cand.id > b.cand.id ? 1 : 0;
  });

  const top = perCandidate[0];
  const runnerUp = perCandidate[1];

  // Ambiguity guard: if a runner-up is within the margin of the top score,
  // refuse to guess. This prevents a bare parent-system applicant from
  // arbitrarily binding to one member hospital.
  if (runnerUp && top.weighted - runnerUp.weighted < ambiguityMargin) {
    return null;
  }

  return { facility: top.cand, score: top.raw, matchedField: top.matchedField };
}

/**
 * Distinct, length-sorted, lowercase tokens suitable for building an `ILIKE`
 * candidate-pool query. Tokens shorter than `minLen` are dropped; numbers and
 * year-like tokens are always included since they are highly discriminating.
 */
export function candidateTokens(applicant: string, minLen = 4): string[] {
  const aliases = splitApplicantAliases(applicant);
  const seen = new Set<string>();
  for (const a of aliases) {
    for (const tok of tokenize(a)) {
      if (tok.length >= minLen || /^\d+$/.test(tok)) seen.add(tok);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}
