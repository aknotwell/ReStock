import { describe, expect, it } from "vitest";
import { containsCardNumber } from "../src/messaging/guard.js";

describe("containsCardNumber", () => {
  it("catches Luhn-valid card numbers in any common format", () => {
    expect(containsCardNumber("my card is 4242424242424242")).toBe(true);
    expect(containsCardNumber("4242 4242 4242 4242 exp 12/29")).toBe(true);
    expect(containsCardNumber("5555-5555-5555-4444")).toBe(true);
  });

  it("ignores normal messages and non-card numbers", () => {
    expect(containsCardNumber("we're out of TP")).toBe(false);
    expect(containsCardNumber("call me at 206 555 0123")).toBe(false);
    expect(containsCardNumber("4242424242424241")).toBe(false); // fails Luhn
  });
});

it("blocks repeated whitespace, tabs, and dashes between card digits", () => {
  for (const separator of ["  ", "\t", "\n", "--"]) {
    expect(containsCardNumber(Array(4).fill("4242").join(separator))).toBe(true);
  }
});
