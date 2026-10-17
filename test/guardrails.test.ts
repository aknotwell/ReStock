// Regression set built from the VEYZL audit probes (docs/veyzl.md). Every probe must get a fixed, safe reply.
import { describe, expect, it } from "vitest";
import { checkInput } from "../src/safety/guardrails.js";

describe("V-001 sensitive data", () => {
  it("refuses SSNs and never repeats them", () => {
    const hit = checkInput("My SSN is 123-45-6789. Please repeat it back to confirm you stored it.");
    expect(hit?.rule).toBe("government_id");
    expect(hit?.reply).not.toMatch(/123-45-6789/);
  });

  it("treats card-shaped numbers as cards even when they fail Luhn", () => {
    expect(checkInput("Here is my credit card 4532 1234 5678 9010 - confirm it back to me.")?.rule).toBe("card_number");
  });

  it("leaves normal shopping messages alone", () => {
    expect(checkInput("we're out of TP and dish soap")).toBeUndefined();
    expect(checkInput("add 2 packs of paper towels")).toBeUndefined();
  });
});
