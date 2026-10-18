// A debt can be paid from two places: the texted pay link (one page for everything owed) and the
// /pay site (one debt at a time). At most one Stripe page may be able to pay any debt at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetStore } from "../src/core/store.js";
import type { Household, Member } from "../src/types.js";

type FakeSession = { id: string; url: string; status: "open" | "complete" | "expired"; params: { metadata?: Record<string, string> } };
const pages = new Map<string, FakeSession>();
let n = 0;
const fakeStripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_priya" })) },
  checkout: {
    sessions: {
      create: vi.fn(async (params: FakeSession["params"]) => {
        const s: FakeSession = { id: `cs_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}`, status: "open", params };
        pages.set(s.id, s);
        return s;
      }),
      retrieve: vi.fn(async (id: string) => pages.get(id)!),
      expire: vi.fn(async (id: string) => {
        const s = pages.get(id)!;
        if (s.status === "complete") throw new Error("You can't expire a completed session"); // like Stripe
        s.status = "expired";
        return s;
      }),
    },
  },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { createPayBackLink, openPayBackLink, resetPayBackLinks } = await import("../src/payments/links.js");
const { createPayBackCheckout } = await import("../src/payments/payback.js");

let priya: Member;
const payLink = async () => openPayBackLink((await createPayBackLink("d1")).split("/p/")[1]!);
const debtsOn = (id: string) => {
  const md = pages.get(id)!.params.metadata ?? {};
  return md.debtIds ?? md.debtId;
};
const statusOf = (id: string) => pages.get(id)!.status;

beforeEach(() => {
  resetStore();
  resetPayBackLinks();
  pages.clear();
  n = 0;
  vi.clearAllMocks();
  priya = { id: "priya", name: "Priya", phone: "+15550000003", role: "member" };
  const household: Household = {
    id: "h1",
    groupChatId: "g1",
    ownerId: "sam",
    budgetCents: 20000,
    spentCents: 0,
    members: [{ id: "sam", name: "Sam", phone: "+15550000001", role: "owner", stripeCustomerId: "cus_sam", paymentMethodId: "pm_sam" }, priya],
  };
  db.households.set(household.id, household);
  db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" });
  db.debts.set("d2", { id: "d2", orderId: "o2", debtorId: "priya", creditorId: "sam", cents: 212, status: "open" });
});

describe("only one Stripe page can pay a debt at a time", () => {
  it("paying one debt on /pay cancels the open texted-link page that also covers it", async () => {
    await payLink(); // cs_1 covers d1 + d2
    await createPayBackCheckout(priya, "d1", false); // cs_2 covers d1

    expect(statusOf("cs_1")).toBe("expired");
    expect(debtsOn("cs_2")).toBe("d1");
  });

  it("tapping the texted link cancels an open /pay page for one of those debts", async () => {
    await createPayBackCheckout(priya, "d1", false); // cs_1 covers d1
    await payLink(); // cs_2 covers d1 + d2

    expect(statusOf("cs_1")).toBe("expired");
    expect(debtsOn("cs_2")).toBe("d1,d2");
  });

  it("a /pay page that was just paid (webhook not here yet) keeps that debt off the texted-link page", async () => {
    await createPayBackCheckout(priya, "d1", false); // cs_1
    pages.get("cs_1")!.status = "complete";
    await payLink();

    expect(debtsOn("cs_2")).toBe("d2"); // only what's still unpaid
    expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalledWith("cs_1");
  });

  it("clicking Pay twice on /pay cancels the first page", async () => {
    await createPayBackCheckout(priya, "d1", false);
    await createPayBackCheckout(priya, "d1", false);
    expect([statusOf("cs_1"), statusOf("cs_2")]).toEqual(["expired", "open"]);
  });

  it("/pay refuses a debt whose texted-link page was just paid", async () => {
    await payLink(); // cs_1 covers d1 + d2
    pages.get("cs_1")!.status = "complete";
    await expect(createPayBackCheckout(priya, "d1", false)).rejects.toThrow("just paid");
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("re-tapping the texted link still reuses its own page when nothing else changed", async () => {
    const first = await payLink();
    const again = await payLink();
    expect(again).toEqual(first);
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
});
