/**
 * Unit tests for FYE timing logic (task #83).
 *
 * Covers `computeTimingBonus` (signalScorer.ts) and `daysUntilFYE` (leads.ts).
 * Both functions share the same boundary semantics — end-of-day on the last
 * calendar day of the FYE month, rolling forward to next year once that
 * moment has passed.
 *
 * Timezone safety: freeze timestamps are derived from the same local-time
 * `new Date(year, month, 0, …)` constructor the implementations use, so the
 * relationship between "now" and FYE is exact regardless of TZ offset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeTimingBonus } from "../src/services/signalScorer";
import { daysUntilFYE } from "../src/routes/leads";

// ─── helpers ─────────────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Return the millisecond timestamp for end-of-day on the last day of `month`
 * in `year` — exactly how `computeTimingBonus` and `daysUntilFYE` compute
 * their FYE target.  Uses a local-time constructor so TZ offset cancels out.
 */
function fyeEndOfDay(month: number, year: number): number {
  return new Date(year, month, 0, 23, 59, 59, 999).getTime();
}

/**
 * Set the fake clock to exactly `days` × 24 h before the FYE end-of-day.
 * Because `Math.round((fyeDate - now) / MS_PER_DAY)` is called with an exact
 * multiple, the implementation returns the integer `days` without rounding.
 */
function freezeDaysBefore(month: number, year: number, days: number): void {
  vi.setSystemTime(new Date(fyeEndOfDay(month, year) - days * MS_PER_DAY));
}

// All tests use fake timers so "new Date()" inside the functions is stable.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ─── computeTimingBonus ──────────────────────────────────────────────────────

describe("computeTimingBonus", () => {
  // ── null / invalid inputs ──────────────────────────────────────────────────
  it("returns 0 for null month", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(computeTimingBonus(null)).toBe(0);
  });

  it("returns 0 for undefined month", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(computeTimingBonus(undefined)).toBe(0);
  });

  it("returns 0 for month 0", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(computeTimingBonus(0)).toBe(0);
  });

  it("returns 0 for month 13", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(computeTimingBonus(13)).toBe(0);
  });

  // ── year-rollover ──────────────────────────────────────────────────────────
  it("rolls to next year the day after FYE (returns 0 — ~365 days away)", () => {
    // FYE = March 2027. Freeze 1 ms after end-of-day Mar 31, 2027 → next FYE is Mar 2028.
    vi.setSystemTime(new Date(fyeEndOfDay(3, 2027) + 1));
    // ~365 days to Mar 2028 → > 180 → bonus = 0
    expect(computeTimingBonus(3)).toBe(0);
  });

  it("returns 20 on the FYE day itself (daysUntil rounds to 0 → ≤ 30)", () => {
    // Freeze 1 ms before end-of-day — daysUntil ≈ 0
    vi.setSystemTime(new Date(fyeEndOfDay(3, 2027) - 1));
    expect(computeTimingBonus(3)).toBe(20);
  });

  // ── bucket midpoints ───────────────────────────────────────────────────────
  it("returns 20 when 15 days away (bucket ≤ 30)", () => {
    freezeDaysBefore(3, 2027, 15);
    expect(computeTimingBonus(3)).toBe(20);
  });

  it("returns 15 when 45 days away (bucket 31–60)", () => {
    freezeDaysBefore(3, 2027, 45);
    expect(computeTimingBonus(3)).toBe(15);
  });

  it("returns 10 when 75 days away (bucket 61–90)", () => {
    freezeDaysBefore(3, 2027, 75);
    expect(computeTimingBonus(3)).toBe(10);
  });

  it("returns 5 when 120 days away (bucket 91–180)", () => {
    freezeDaysBefore(3, 2027, 120);
    expect(computeTimingBonus(3)).toBe(5);
  });

  it("returns 0 when 200 days away (> 180)", () => {
    freezeDaysBefore(3, 2027, 200);
    expect(computeTimingBonus(3)).toBe(0);
  });

  // ── exact boundary edges ───────────────────────────────────────────────────
  it("boundary at exactly 30 days → bonus 20 (≤ 30)", () => {
    freezeDaysBefore(3, 2027, 30);
    expect(computeTimingBonus(3)).toBe(20);
  });

  it("boundary at exactly 31 days → bonus 15 (> 30, ≤ 60)", () => {
    freezeDaysBefore(3, 2027, 31);
    expect(computeTimingBonus(3)).toBe(15);
  });

  it("boundary at exactly 60 days → bonus 15 (≤ 60)", () => {
    freezeDaysBefore(3, 2027, 60);
    expect(computeTimingBonus(3)).toBe(15);
  });

  it("boundary at exactly 61 days → bonus 10 (> 60, ≤ 90)", () => {
    freezeDaysBefore(3, 2027, 61);
    expect(computeTimingBonus(3)).toBe(10);
  });

  it("boundary at exactly 90 days → bonus 10 (≤ 90)", () => {
    freezeDaysBefore(3, 2027, 90);
    expect(computeTimingBonus(3)).toBe(10);
  });

  it("boundary at exactly 91 days → bonus 5 (> 90, ≤ 180)", () => {
    freezeDaysBefore(3, 2027, 91);
    expect(computeTimingBonus(3)).toBe(5);
  });

  it("boundary at exactly 180 days → bonus 5 (≤ 180)", () => {
    freezeDaysBefore(3, 2027, 180);
    expect(computeTimingBonus(3)).toBe(5);
  });

  it("boundary at exactly 181 days → bonus 0 (> 180)", () => {
    freezeDaysBefore(3, 2027, 181);
    expect(computeTimingBonus(3)).toBe(0);
  });

  // ── February edge case ─────────────────────────────────────────────────────
  it("handles February correctly — last day is 28th in non-leap year", () => {
    freezeDaysBefore(2, 2027, 10);
    expect(computeTimingBonus(2)).toBe(20);
  });
});

// ─── daysUntilFYE ─────────────────────────────────────────────────────────────

describe("daysUntilFYE", () => {
  // ── null / invalid inputs ──────────────────────────────────────────────────
  it("returns null for null month", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(daysUntilFYE(null)).toBeNull();
  });

  it("returns null for undefined month", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(daysUntilFYE(undefined)).toBeNull();
  });

  it("returns null for month 0", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(daysUntilFYE(0)).toBeNull();
  });

  it("returns null for month 13", () => {
    freezeDaysBefore(6, 2027, 45);
    expect(daysUntilFYE(13)).toBeNull();
  });

  // ── exact boundary edges ───────────────────────────────────────────────────
  it("returns 30 when exactly 30 days before FYE", () => {
    freezeDaysBefore(3, 2027, 30);
    expect(daysUntilFYE(3)).toBe(30);
  });

  it("returns 31 when exactly 31 days before FYE", () => {
    freezeDaysBefore(3, 2027, 31);
    expect(daysUntilFYE(3)).toBe(31);
  });

  it("returns 60 when exactly 60 days before FYE", () => {
    freezeDaysBefore(3, 2027, 60);
    expect(daysUntilFYE(3)).toBe(60);
  });

  it("returns 61 when exactly 61 days before FYE", () => {
    freezeDaysBefore(3, 2027, 61);
    expect(daysUntilFYE(3)).toBe(61);
  });

  it("returns 90 when exactly 90 days before FYE", () => {
    freezeDaysBefore(3, 2027, 90);
    expect(daysUntilFYE(3)).toBe(90);
  });

  it("returns 91 when exactly 91 days before FYE", () => {
    freezeDaysBefore(3, 2027, 91);
    expect(daysUntilFYE(3)).toBe(91);
  });

  it("returns 180 when exactly 180 days before FYE", () => {
    freezeDaysBefore(3, 2027, 180);
    expect(daysUntilFYE(3)).toBe(180);
  });

  it("returns 181 when exactly 181 days before FYE", () => {
    freezeDaysBefore(3, 2027, 181);
    expect(daysUntilFYE(3)).toBe(181);
  });

  // ── year-rollover ──────────────────────────────────────────────────────────
  it("rolls to next year the day after FYE and returns a value > 180", () => {
    vi.setSystemTime(new Date(fyeEndOfDay(3, 2027) + 1));
    const result = daysUntilFYE(3);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(180);
  });

  it("returns 0 or 1 on the FYE day itself (1 ms before end-of-day)", () => {
    vi.setSystemTime(new Date(fyeEndOfDay(3, 2027) - 1));
    const result = daysUntilFYE(3);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThanOrEqual(1);
  });

  // ── semantics parity with computeTimingBonus ───────────────────────────────
  it("value at 30 days maps to bonus 20", () => {
    freezeDaysBefore(3, 2027, 30);
    expect(daysUntilFYE(3)).toBe(30);
    expect(computeTimingBonus(3)).toBe(20);
  });

  it("value at 31 days maps to bonus 15", () => {
    freezeDaysBefore(3, 2027, 31);
    expect(daysUntilFYE(3)).toBe(31);
    expect(computeTimingBonus(3)).toBe(15);
  });

  it("value at 180 days maps to bonus 5", () => {
    freezeDaysBefore(3, 2027, 180);
    expect(daysUntilFYE(3)).toBe(180);
    expect(computeTimingBonus(3)).toBe(5);
  });

  it("value at 181 days maps to bonus 0", () => {
    freezeDaysBefore(3, 2027, 181);
    expect(daysUntilFYE(3)).toBe(181);
    expect(computeTimingBonus(3)).toBe(0);
  });
});
