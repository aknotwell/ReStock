// Approvals by text: who can say "yes", and which items wait for one (src/core/approvals.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic parsing and matching, so these tests never call the model.
vi.mock("../src/ai/parseMessage.js", async () => {
  const { parseCommand } = await import("../src/messaging/commands.js");
  return { parseMessage: async (text: string) => parseCommand(text) };
});
vi.mock("../src/ai/matchItem.js", async () => {
  const { keywordMatch } = await import("../src/core/catalog.js");
  return { matchItem: async (r: string) => { const p = keywordMatch(r); return p ? { product: p, source: "keyword" } : undefined; } };
});

const { seedDemo } = await import("../scripts/seed.js");
const { pendingItems } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { captureOutboundDetailed } = await import("../src/messaging/photon.js");
const { approverNames, needsApproval } = await import("../src/core/approvals.js");

const SAM = "+15550000001", JAKE = "+15550000002", PRIYA = "+15550000003";
let n = 0;
const say = (fromPhone: string, text: string, spaceKind: "group" | "direct" = "group") =>
  captureOutboundDetailed(() => handleInbound({ messageId: `a${++n}`, spaceId: spaceKind === "group" ? "grp" : `dm-${fromPhone}`, spaceKind, fromPhone, text }));
const texts = (out: { text: string }[]) => out.map((o) => o.text).join("\n");
const waiting = () => pendingItems("demo-house").filter((i) => i.needsApproval);

let household: ReturnType<typeof seedDemo>;
beforeEach(() => {
  household = seedDemo();
  household.groupChatId = "grp";
});

describe("family: only the people the owner picks can approve", () => {
  beforeEach(() => {
    household.members.find((m) => m.id === "priya")!.canApprove = false; // Priya plays the kid
    household.members.find((m) => m.id === "jake")!.canApprove = false;
  });

  it("a kid's request shows the best match and waits for the owner's yes", async () => {
    expect(texts(await say(PRIYA, "add coffee"))).toMatch(/Which one\?/);
    const out = await say(PRIYA, "1");
    expect(texts(out)).toMatch(/Priya asked for Ground coffee, 24 oz .*\$12\.99.*Sam: reply "yes"/);
    expect(waiting().map((i) => i.name)).toEqual(["Ground coffee, 24 oz"]);

    expect(texts(await say(PRIYA, "yes"))).toMatch(/Only Sam can approve that/);
    expect(waiting()).toHaveLength(1);

    expect(texts(await say(SAM, "yes"))).toMatch(/Approved by Sam: Ground coffee/);
    expect(waiting()).toHaveLength(0);
  });

  it("a request sent privately still reaches the group, where the approver sees it", async () => {
    expect(texts(await say(PRIYA, "add coffee", "direct"))).toMatch(/Which one\?/);
    const out = await say(PRIYA, "1", "direct");
    expect(out.find((o) => o.spaceId === `dm-${PRIYA}`)?.text).toMatch(/Best match: Ground coffee.*asked Sam to approve/);
    expect(out.find((o) => o.spaceId === "grp")?.text).toMatch(/Priya asked for Ground coffee/);
  });
});

describe("roommates: everyone can approve", () => {
  it("an approver's everyday request goes straight into the cart", async () => {
    expect(texts(await say(JAKE, "add coffee"))).toMatch(/Which one\?/);
    expect(texts(await say(JAKE, "1"))).toMatch(/^Added Ground coffee/);
    expect(waiting()).toHaveLength(0);
  });

  it("an item over the limit needs someone else's yes, not the person who added it", async () => {
    expect(texts(await say(JAKE, "add air fryer"))).toMatch(/Which one\?/);
    expect(texts(await say(JAKE, "1"))).toMatch(/Jake asked for Air fryer.*Sam or Priya: reply "yes"/);
    expect(texts(await say(JAKE, "yes"))).toMatch(/Only Sam or Priya can approve that/);
    expect(waiting()).toHaveLength(1);
    expect(texts(await say(PRIYA, "yes"))).toMatch(/Approved by Priya: Air fryer/);
    expect(waiting()).toHaveLength(0);
  });

  it("the owner's own items never wait", () => {
    const sam = household.members.find((m) => m.id === "sam")!;
    expect(needsApproval(household, sam, 999_999)).toBe(false);
  });
});

it("lists approvers in plain English", () => {
  expect(approverNames(household)).toBe("Sam, Jake or Priya");
  expect(approverNames(household, "jake")).toBe("Sam or Priya");
});
