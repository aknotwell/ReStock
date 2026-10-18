import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetStore } from "../src/core/store.js";
import { chargeOrder } from "../src/payments/charges.js";
import { resetCardLinks } from "../src/payments/links.js";
import {
  assertOwnerCard,
  OwnerCardRequiredError,
  ownerCardRequest,
  ownerHasCard,
} from "../src/payments/ownerGate.js";
import type { Household, Order } from "../src/types.js";

let household: Household;

beforeEach(() => {
  resetStore();
  resetCardLinks();
  household = {
    id: "h1",
    groupChatId: "g1",
    ownerId: "sam",
    budgetCents: 40000,
    spentCents: 0,
    members: [
      { id: "sam", name: "Sam", phone: "+15550000001", role: "owner" },
      { id: "jake", name: "Jake", phone: "+15550000002", role: "member", paymentMethodId: "pm_jake", cardLast4: "1881" },
    ],
  };
  db.households.set(household.id, household);
});

const order: Order = { id: "o1", householdId: "h1", itemIds: [], totalCents: 1000, rule: "smart", createdAt: "" };

describe("owner card gate", () => {
  it("blocks when the owner has no card, even if other members do", () => {
    expect(ownerHasCard(household)).toBe(false);
    expect(() => assertOwnerCard(household)).toThrow(OwnerCardRequiredError);
    expect(() => assertOwnerCard(household)).toThrow("Sam needs to add a card before I can order.");
  });

  it("passes once the owner has a card", () => {
    household.members[0]!.paymentMethodId = "pm_sam";
    expect(ownerHasCard(household)).toBe(true);
    expect(() => assertOwnerCard(household)).not.toThrow();
  });

  it("blocks when the household's owner isn't a member (bad data)", () => {
    household.ownerId = "nobody";
    expect(() => assertOwnerCard(household)).toThrow("This household has no budget owner yet.");
  });

  it("chargeOrder refuses to run without the owner's card", async () => {
    await expect(chargeOrder(order, { sam: 500, jake: 500 }, household)).rejects.toThrow(OwnerCardRequiredError);
  });
});

describe("ownerCardRequest", () => {
  it("tells the group briefly and sends the add-card link only to the owner", async () => {
    const req = await ownerCardRequest(household);
    expect(req.ownerId).toBe("sam");
    expect(req.groupText).toBe("Sam needs to add a card before I can order. Sam, I've texted you a secure link.");
    expect(req.groupText).not.toContain("http");
    expect(req.ownerText).toMatch(/\/c\/[A-Za-z0-9_-]{20,}/);
    expect(req.ownerText).toContain('text "order now" again');
  });

  it("has no private text when there is no owner to send it to", async () => {
    household.ownerId = "nobody";
    const req = await ownerCardRequest(household);
    expect(req.ownerId).toBeUndefined();
    expect(req.ownerText).toBeUndefined();
  });
});

describe("owner card gate in the chat (console mode)", () => {
  // Imported lazily so the plain unit tests above don't load the messaging stack.
  const SAM = "+15550000001";
  const JAKE = "+15550000002";
  let n = 0;
  const msg = (fromPhone: string, text: string, spaceKind: "group" | "direct" = "group") => ({
    messageId: `gate${++n}`,
    spaceId: spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${fromPhone}`,
    spaceKind,
    fromPhone,
    text,
    agentUserId: "pho_usr_agent",
  });

  async function orderNowWithoutOwnerCard(from: string, spaceKind: "group" | "direct") {
    const { seedDemo } = await import("../scripts/seed.js");
    const { handleInbound } = await import("../src/messaging/inbound.js");
    const { rememberInbound } = await import("../src/messaging/photon.js");
    const h = seedDemo();
    delete h.members.find((m) => m.id === "sam")!.paymentMethodId;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    for (const m of [msg(from, "help", spaceKind), msg(from, "order now", spaceKind)]) {
      rememberInbound(m);
      await handleInbound(m);
    }
    spy.mockRestore();
    return { out: logs.join("\n"), household: h };
  }

  it('a roommate\'s "order now" stops, tells the group, and DMs Sam the link', async () => {
    const { out, household: h } = await orderNowWithoutOwnerCard(JAKE, "group");
    expect(out).toMatch(/I can't order for Sam's household \(Sam, you and Priya\) yet\. Sam is the budget owner[^\n]*I've texted Sam a secure link to add one\. Nothing was charged and the cart is saved/);
    expect(out).toMatch(/→ Sam \(private\)\]\nYou're the budget owner[^\n]*\/c\/[A-Za-z0-9]{20,}/);
    expect(db.orders.size).toBe(0);
    expect(h.spentCents).toBe(0);
  });

  it("Sam texting the agent directly gets the link right there, once", async () => {
    const { out } = await orderNowWithoutOwnerCard(SAM, "direct");
    expect(out).toMatch(/You're the budget owner[^\n]*\/c\/[A-Za-z0-9]{20,}/);
    expect(out).not.toMatch(/Sam needs to add a card/);
    expect(out.match(/You're the budget owner/g)).toHaveLength(1);
  });
});

describe("add-card links survive the outbound redact() filter", () => {
  it("never loses part of a link to redaction", async () => {
    const { redact } = await import("../src/safety/redact.js");
    const { createCardSetupLink } = await import("../src/payments/links.js");
    for (let i = 0; i < 2000; i++) {
      const link = await createCardSetupLink("sam");
      expect(link).toMatch(/\/c\/[A-Za-z0-9]{22}$/);
      expect(redact(link)).toBe(link);
    }
  });
});
