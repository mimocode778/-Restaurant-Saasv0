import { describe, expect, it } from "vitest";
import { formatQuantity, formatQuantityPlain, parseQuantity } from "./quantity";

describe("quantity", () => {
  it("reads kilograms and litres into grams and millilitres", () => {
    expect(parseQuantity("1,5", "g")).toBe(1500);
    expect(parseQuantity("0.75", "ml")).toBe(750);
    expect(parseQuantity(" 12 ", "g")).toBe(12000);
    expect(parseQuantity("0,005", "g")).toBe(5);
    expect(parseQuantity("1 250,5", "g")).toBe(1_250_500);
  });

  it("refuses more than 3 decimals, negative or nonsense values", () => {
    expect(parseQuantity("1,2345", "g")).toBeNull();
    expect(parseQuantity("-1", "g")).toBeNull();
    expect(parseQuantity("abc", "ml")).toBeNull();
    expect(parseQuantity("", "g")).toBeNull();
  });

  it("only accepts whole pieces", () => {
    expect(parseQuantity("12", "piece")).toBe(12);
    expect(parseQuantity("1,5", "piece")).toBeNull();
  });

  it("refuses absurdly large quantities", () => {
    expect(parseQuantity("2000000", "g")).toBeNull();
    expect(parseQuantity("1000000", "g")).toBe(1_000_000_000);
  });

  it("formats for the screens, dropping useless zeros", () => {
    expect(formatQuantity(1500, "g")).toBe("1,5 kg");
    expect(formatQuantity(750, "ml")).toBe("0,75 L");
    expect(formatQuantity(2000, "g")).toBe("2 kg");
    expect(formatQuantity(-200, "g")).toBe("-0,2 kg");
    expect(formatQuantity(12, "piece")).toBe("12 pièce(s)");
    expect(formatQuantityPlain(1005, "g")).toBe("1,005");
  });

  it("refuses fractional base quantities", () => {
    expect(() => formatQuantity(1.5, "g")).toThrow();
  });
});
