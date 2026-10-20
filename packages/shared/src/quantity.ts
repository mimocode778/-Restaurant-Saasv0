// Stock quantities are always a whole number in a "base unit": grams, millilitres or pieces.
// People type and read kilograms and litres; these helpers convert without rounding errors
// (1 kg = 1000 g, 1 L = 1000 ml), the same way money uses millimes.
export type BaseUnit = "g" | "ml" | "piece";

export const BASE_UNITS: readonly BaseUnit[] = ["g", "ml", "piece"];

// The largest quantity accepted: 1,000,000 kg / L / pieces. More is certainly a typing mistake.
export const MAX_QUANTITY_BASE = 1_000_000_000;

export function assertQuantity(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Not a whole quantity in the base unit: ${value}`);
  }
  return value;
}

// The unit shown on screens for a base unit.
export function displayUnit(unit: BaseUnit): string {
  if (unit === "g") return "kg";
  if (unit === "ml") return "L";
  return "pièce(s)";
}

// Reads a quantity typed by a person into the base unit.
// For grams and millilitres the text is in kg or L ("1,5" -> 1500), at most 3 decimals.
// For pieces it must be a whole number. Returns null if it is not a valid, non-negative quantity.
export function parseQuantity(text: string, unit: BaseUnit): number | null {
  const clean = text.trim().replace(/\s| /g, "").replace(",", ".");
  if (unit === "piece") {
    if (!/^\d{1,9}$/.test(clean)) return null;
    const n = Number(clean);
    return n <= MAX_QUANTITY_BASE ? n : null;
  }
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(clean);
  if (!m) return null;
  const base = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  return base <= MAX_QUANTITY_BASE ? base : null;
}

// "1,5 kg", "0,75 L", "12 pièce(s)", "-0,2 kg". Trailing zeros are dropped.
export function formatQuantity(value: number, unit: BaseUnit): string {
  assertQuantity(value);
  if (unit === "piece") return `${value} ${displayUnit(unit)}`;
  return `${formatQuantityPlain(value, unit)} ${displayUnit(unit)}`;
}

// The number alone ("1,5"), for filling an input field.
export function formatQuantityPlain(value: number, unit: BaseUnit): string {
  assertQuantity(value);
  if (unit === "piece") return String(value);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 1000);
  const decimals = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}${decimals ? "," + decimals : ""}`;
}
