// Money is always an integer number of millimes (1 TND = 1000 millimes).
export type Millimes = number;

export function tnd(amount: number): Millimes {
  return Math.round(amount * 1000);
}

export function assertMillimes(value: number): Millimes {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Not an integer amount of millimes: ${value}`);
  }
  return value;
}

export function add(...values: Millimes[]): Millimes {
  return assertMillimes(values.reduce((sum, v) => sum + assertMillimes(v), 0));
}

// Multiply by a quantity or rate and round to the nearest millime.
// Rounds half away from zero.
export function multiply(amount: Millimes, factor: number): Millimes {
  const result = amount * factor;
  return assertMillimes(Math.sign(result) * Math.round(Math.abs(result)));
}

// Split an amount into parts without losing a millime.
// The remainder is spread one millime at a time from the first part.
export function split(amount: Millimes, parts: number): Millimes[] {
  assertMillimes(amount);
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error("parts must be a positive integer");
  }
  const base = Math.trunc(amount / parts);
  let remainder = amount - base * parts;
  const step = remainder < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    if (remainder !== 0) {
      remainder -= step;
      return base + step;
    }
    return base;
  });
}

// "12,500 TND" style display with three decimals, as Tunisian prices use.
export function format(amount: Millimes): string {
  assertMillimes(amount);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const dinars = Math.trunc(abs / 1000);
  const millimes = String(abs % 1000).padStart(3, "0");
  return `${sign}${dinars},${millimes} TND`;
}

// Reads an amount typed by a person ("12,500", "12.5", "1 250,750", "8") into millimes.
// Returns null if it is not a valid, non-negative amount with at most 3 decimals.
export function parseTnd(text: string): Millimes | null {
  const clean = text.trim().replace(/\s| |TND|DT/gi, "").replace(",", ".");
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(clean);
  if (!m) return null;
  const millimes = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(millimes) ? millimes : null;
}

// "12,500" (no currency), for filling an input field.
export function formatTndPlain(amount: Millimes): string {
  return format(amount).replace(" TND", "");
}
