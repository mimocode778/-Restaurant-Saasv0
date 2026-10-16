import { describe, expect, it } from "vitest";
import { add, format, multiply, split, tnd } from "./money";

describe("money", () => {
  it("converts dinars to millimes without float errors", () => {
    expect(tnd(12.5)).toBe(12500);
    expect(tnd(0.1) + tnd(0.2)).toBe(300);
  });

  it("adds integers", () => {
    expect(add(1500, 2500, 750)).toBe(4750);
  });

  it("rejects fractional millimes", () => {
    expect(() => add(1.5, 2)).toThrow();
  });

  it("multiplies and rounds half away from zero", () => {
    expect(multiply(1000, 1.0005)).toBe(1001);
    expect(multiply(-1000, 1.0005)).toBe(-1001);
  });

  it("splits without losing a millime", () => {
    const parts = split(1000, 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("splits negative amounts too", () => {
    const parts = split(-1000, 3);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-1000);
  });

  it("formats with three decimals", () => {
    expect(format(12500)).toBe("12,500 TND");
    expect(format(5)).toBe("0,005 TND");
    expect(format(-1250)).toBe("-1,250 TND");
  });
});
