import { assertMillimes, type Millimes } from "./money.js";

// VAT rates are stored in basis points: 1 % = 100, so 19 % = 1900 and 7 % = 700.
// Whole numbers only, so there is never a rounding error on the rate itself.
export type BasisPoints = number;

export function assertRate(rate: BasisPoints): BasisPoints {
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    throw new Error(`Not a valid VAT rate in basis points (0 to 10000): ${rate}`);
  }
  return rate;
}

export interface VatSplit {
  ttc: Millimes; // price including VAT, what the customer pays
  ht: Millimes; // price before VAT
  vat: Millimes; // VAT part
}

// Splits a price including VAT into its before-VAT part and its VAT part, to the millime.
// ht is rounded to the nearest millime (half away from zero) and vat = ttc - ht, so the
// two parts always add up exactly to the price the customer pays.
export function splitTtc(ttc: Millimes, rate: BasisPoints): VatSplit {
  assertMillimes(ttc);
  assertRate(rate);
  const exact = (ttc * 10_000) / (10_000 + rate);
  const ht = Math.sign(exact) * Math.round(Math.abs(exact));
  return { ttc, ht, vat: ttc - ht };
}

// "19 %" or "13,5 %" for display.
export function formatRate(rate: BasisPoints): string {
  assertRate(rate);
  const whole = Math.trunc(rate / 100);
  const rest = rate % 100;
  return rest === 0 ? `${whole} %` : `${whole},${String(rest).padStart(2, "0").replace(/0$/, "")} %`;
}

// Reads a rate typed by a person ("19", "7", "13,5", "19 %") into basis points.
export function parseRate(text: string): BasisPoints | null {
  const clean = text.trim().replace(/\s|%/g, "").replace(",", ".");
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}
