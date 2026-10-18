// "over budget, needs Sam's OK" must never be shown to Sam, the owner: the owner needs nobody's OK.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

const { seedDemo } = await import("../scripts/seed.js");
const { db, getHousehold, pendingItems } = await import("../src/core/store.js");
const { getProduct } = await import("../src/core/catalog.js");
const { buildChoice, choicePrompt, clearPendingChoices } = await import("../src/messaging/options.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");

const H = "demo-house";
const SAM = "+15550000001", JAKE = "+15550000002";
let logs: string[];

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  const h = getHousehold(H);
  h.spentCents = h.budgetCents! - 7275 - 1500; // $15 left after the starter cart: the bigger TP packs are over budget
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the over-budget label", () => {
  const tp = () => getProduct("tp-12")!;

  it("asks a member to get the owner's OK", () => {
    const prompt = choicePrompt(buildChoice(H, tp(), null, {}, [], "jake"));
    expect(prompt).toMatch(/over budget, needs Sam's OK/);
  });

  it("just says 'over budget' to the owner", () => {
    const prompt = choicePrompt(buildChoice(H, tp(), null, {}, [], "sam"));
    expect(prompt).toMatch(/over budget/);
    expect(prompt).not.toMatch(/needs .*OK/);
  });

  it("keeps the old label when nobody says who's asking", () => {
    expect(choicePrompt(buildChoice(H, tp(), null))).toMatch(/needs Sam's OK/);
  });
});

describe("over chat", () => {
  let n = 0;
  async function say(from: string, text: string) {
    const msg = { messageId: `ob${++n}`, spaceId: "pho_spc_group", spaceKind: "group" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
    rememberInbound(msg);
    await handleInbound(msg);
  }
  const out = () => logs.join("\n");

  beforeEach(async () => {
    await say(SAM, "help"); // binds the group chat
    logs = [];
  });

  it("the owner sees 'over budget' without 'needs Sam's OK', and an over-budget pick is added right away", async () => {
    await say(SAM, "add tp");
    expect(out()).toMatch(/over budget\)/);
    expect(out()).not.toMatch(/needs Sam's OK/);
    const before = pendingItems(H).length;
    await say(SAM, "1"); // the first option is over budget
    const added = pendingItems(H).at(-1)!;
    expect(pendingItems(H)).toHaveLength(before + 1);
    expect(added.needsApproval).toBeFalsy();
    expect(out()).toMatch(/over this month's budget/);
  });

  it("a member still sees 'needs Sam's OK', and their over-budget pick waits for approval", async () => {
    await say(JAKE, "add tp");
    expect(out()).toMatch(/over budget, needs Sam's OK/);
    await say(JAKE, "1");
    expect(pendingItems(H).at(-1)!.needsApproval).toBe(true);
    expect(db.items.size).toBeGreaterThan(0);
  });
});
