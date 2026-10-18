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

describe("containsCardNumber separators", () => {
  // Stripe test numbers only (Visa, Mastercard, Amex).
  const groups = ["4242", "4242", "4242", "4242"];

  it.each([
    ["double spaces", "  "], ["tabs", "\t"], ["newlines", "\n"], ["dots", "."], ["slashes", "/"],
    ["underscores", "_"], ["double dashes", "--"], ["en dashes", "\u2013"], ["space-dash-space", " - "],
  ])("catches a card separated by %s", (_name, sep) => {
    expect(containsCardNumber(groups.join(sep))).toBe(true);
  });

  it("catches a card followed by its expiry and CVC", () => {
    expect(containsCardNumber("4242 4242 4242 4242 12/29 123")).toBe(true);
    expect(containsCardNumber("5555 5555 5555 4444 0130 999")).toBe(true);
  });

  it("catches an Amex in its 4-6-5 layout with odd separators", () => {
    expect(containsCardNumber("3782.822463.10005")).toBe(true);
  });

  it("catches a card after a quantity", () => {
    expect(containsCardNumber("add 2 chips 4242 4242 4242 4242")).toBe(true);
  });

  it("still ignores ordinary numbers", () => {
    for (const t of ["add 2 dish soap", "add 12 rolls", "call 206-555-0123 or 425.555.0199", "order #12345678", "zip 98105, apt 4", "10/17/2026 at 3:30"]) {
      expect(containsCardNumber(t)).toBe(false);
    }
  });
});
