import { describe, expect, it } from "vitest";
import { formatRate, splitTtc } from "./vat";

describe("splitting a price including VAT", () => {
  it("works out the before-VAT price and the VAT, to the millime", () => {
    // 11,900 TND at 19 %: 11,900 / 1.19 = 10,000 before VAT, 1,900 VAT.
    expect(splitTtc(11_900, 1900)).toEqual({ ttc: 11_900, ht: 10_000, vat: 1_900 });
    // 10,700 TND at 7 %: 10,700 / 1.07 = 10,000 before VAT, 700 VAT.
    expect(splitTtc(10_700, 700)).toEqual({ ttc: 10_700, ht: 10_000, vat: 700 });
  });

  it("rounds to the nearest millime and the parts always add up to the price", () => {
    // 12,500 / 1.19 = 10,504.20... -> 10,504 before VAT, 1,996 VAT.
    expect(splitTtc(12_500, 1900)).toEqual({ ttc: 12_500, ht: 10_504, vat: 1_996 });
    for (const ttc of [1, 5, 999, 2_350, 12_345, 99_999]) {
      for (const rate of [0, 700, 1300, 1900]) {
        const s = splitTtc(ttc, rate);
        expect(s.ht + s.vat).toBe(ttc);
        expect(s.vat).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("handles no VAT and refunds", () => {
    expect(splitTtc(5_000, 0)).toEqual({ ttc: 5_000, ht: 5_000, vat: 0 });
    expect(splitTtc(-11_900, 1900)).toEqual({ ttc: -11_900, ht: -10_000, vat: -1_900 });
  });

  it("refuses impossible rates and fractional millimes", () => {
    expect(() => splitTtc(1000, -1)).toThrow();
    expect(() => splitTtc(1000, 10_001)).toThrow();
    expect(() => splitTtc(1000, 19.5)).toThrow();
    expect(() => splitTtc(1000.5, 1900)).toThrow();
  });
});

describe("showing a rate", () => {
  it("writes it the French way", () => {
    expect(formatRate(1900)).toBe("19 %");
    expect(formatRate(700)).toBe("7 %");
    expect(formatRate(1350)).toBe("13,5 %");
    expect(formatRate(1325)).toBe("13,25 %");
  });
});
