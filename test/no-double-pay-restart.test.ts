// A combined pay page saved before page tracking existed must still block a second page after a restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pages = new Map<string, { id: string; url: string; status: "open" | "complete" | "expired" }>();
const fakeStripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_priya" })) },
  checkout: {
    sessions: {
      create: vi.fn(async () => {
        const s = { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new", status: "open" as const };
        pages.set(s.id, s);
        return s;
      }),
      retrieve: vi.fn(async (id: string) => pages.get(id)!),
      expire: vi.fn(async (id: string) => Object.assign(pages.get(id)!, { status: "expired" as const })),
    },
  },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "restock-pages-"));
  file = path.join(dir, "restock.db");
  pages.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  (await import("../src/core/persist.js")).closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  vi.resetModules();
  return {
    persist: await import("../src/core/persist.js"),
    store: await import("../src/core/store.js"),
    seed: await import("../scripts/seed.js"),
    payback: await import("../src/payments/payback.js"),
  };
}

it("after a restart, /pay still cancels a combined page saved in the older format", async () => {
  // Server 1: the demo household with one debt, saved.
  const a = await boot();
  a.persist.openDatabase(file);
  a.seed.seedDemo();
  a.store.db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" });
  a.persist.saveNow();
  a.persist.closeDatabase();

  // Rewrite the saved links as an older build would have: a combined page, and no `pages` field.
  pages.set("cs_old", { id: "cs_old", url: "https://checkout.stripe.com/c/pay/cs_old", status: "open" });
  const raw = new DatabaseSync(file);
  raw
    .prepare("UPDATE state SET data = ? WHERE name = 'payment-links'")
    .run(JSON.stringify({ card: [], payBack: [], sessions: [["priya->sam", { sessionId: "cs_old", debtIds: ["d1"] }]] }));
  raw.close();

  // Server 2: loads that save. Paying d1 on /pay must cancel the old combined page first.
  const b = await boot();
  b.persist.openDatabase(file);
  const priya = b.store.findMember("priya")!.member;
  await b.payback.createPayBackCheckout(priya, "d1", false);
  expect(fakeStripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_old");
  expect(pages.get("cs_old")!.status).toBe("expired");
});
