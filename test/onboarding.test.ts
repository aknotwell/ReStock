// First contact: Restock says hi and sets up a personal space or a group by asking questions.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic parsing and matching, so these tests never call the model.
vi.mock("../src/ai/parseMessage.js", async () => {
  const { parseCommand } = await import("../src/messaging/commands.js");
  return { parseMessage: async (text: string) => parseCommand(text) };
});

const { db, householdsForPhone, resetStore } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { captureOutboundDetailed } = await import("../src/messaging/photon.js");
const { nameFrom, parseBudget, resetOnboarding } = await import("../src/messaging/onboarding.js");

const ALEX = "+12065550101", JAKE = "+12065550102", MAYA = "+12065550103";
let n = 0;
const dm = (from: string, text: string) =>
  captureOutboundDetailed(() => handleInbound({ messageId: `o${++n}`, spaceId: `dm-${from}`, spaceKind: "direct", fromPhone: from, text }));
const inGroup = (from: string, text: string, spaceId = "grp") =>
  captureOutboundDetailed(() => handleInbound({ messageId: `o${++n}`, spaceId, spaceKind: "group", fromPhone: from, text }));
const said = (out: { text: string }[]) => out.map((o) => o.text).join("\n");

beforeEach(() => {
  resetStore();
  resetOnboarding();
});

describe("one-on-one: a personal space", () => {
  it("says hi, explains itself, then asks name and budget", async () => {
    expect(said(await dm(ALEX, "yo"))).toMatch(/^Hi! I'm Restock, an AI assistant \(not a person\)[\s\S]*"just me" or "group"/);
    expect(said(await dm(ALEX, "it's just me"))).toMatch(/What should I call you\?/);
    expect(said(await dm(ALEX, "I'm alex"))).toMatch(/Hi Alex! Want a monthly budget\?/);
    const done = said(await dm(ALEX, "$150"));
    expect(done).toMatch(/You're set up, Alex\. Monthly budget: \$150\.00\./);
    expect(done).toMatch(/\/c\/[A-Za-z0-9]{20,}/); // add-card link
    expect(done).toMatch(/\/dashboard/); // log in

    const [space] = householdsForPhone(ALEX);
    expect(space).toMatchObject({ kind: "personal", budgetCents: 15000, members: [{ name: "Alex", role: "owner" }] });
  });

  it("works without a budget, and re-asks when an answer doesn't fit", async () => {
    await dm(ALEX, "hi");
    expect(said(await dm(ALEX, "huh?"))).toMatch(/"just me" or "group"/);
    await dm(ALEX, "me");
    await dm(ALEX, "Alex");
    expect(said(await dm(ALEX, "lots"))).toMatch(/Reply an amount like 150, or "no budget"/);
    expect(said(await dm(ALEX, "no budget"))).toMatch(/No monthly budget\./);
    expect(householdsForPhone(ALEX)[0]?.budgetCents).toBeUndefined();
  });

  it("'group' sets up a household here and hands out an invite link (shared lines can't share one group chat)", async () => {
    await dm(ALEX, "hi");
    expect(said(await dm(ALEX, "for my roommates"))).toMatch(/I'll set up your group.*What should I call you/s);
    await dm(ALEX, "Alex");
    const done = said(await dm(ALEX, "200"));
    expect(done).toMatch(/You're set up, Alex! Monthly budget: \$200\.00\./);
    expect(done).toMatch(/Invite everyone with this link\. .*\/join\/[A-Za-z0-9_-]{16}/);
    expect(done).not.toMatch(/Add me to your group chat/);
    const [h] = householdsForPhone(ALEX);
    expect(h).toMatchObject({ kind: "group", groupType: "roommates", groupChatId: "unbound", budgetCents: 20000 });
  });

  it("after setup, texts go to the personal space", async () => {
    for (const t of ["hi", "just me", "Alex", "no"]) await dm(ALEX, t);
    expect(said(await dm(ALEX, "help"))).toMatch(/I'm Restock/);
    expect(said(await dm(ALEX, "hi"))).not.toMatch(/just me" or "group/);
  });
});

describe("group chat: roommates or family", () => {
  it("roommates: the main card answers, then people join and can approve", async () => {
    expect(said(await inGroup(ALEX, "hey restock"))).toMatch(/^Hi everyone![\s\S]*"roommates", "family", or "other"/);
    expect(said(await inGroup(JAKE, "we're roommates"))).toMatch(/Whose card pays for orders\?.*reply "me"/);
    expect(await inGroup(JAKE, "lol who")).toHaveLength(0); // chatter while waiting stays quiet
    expect(said(await inGroup(ALEX, "me"))).toMatch(/What should I call you\?/);
    expect(await inGroup(JAKE, "Jake")).toHaveLength(0); // only the main card answers the rest
    await inGroup(ALEX, "Alex");
    const done = await inGroup(ALEX, "200");
    expect(said(done)).toMatch(/All set! Alex's card pays for orders[\s\S]*Monthly budget: \$200\.00\. Anyone here can approve/);
    expect(done.find((o) => o.memberId)?.text).toMatch(/Add the group's main card[\s\S]*\/dashboard/); // private to Alex

    const join = await inGroup(JAKE, "I'm Jake");
    expect(said(join)).toMatch(/Welcome, Jake!/);
    const group = [...db.households.values()].find((h) => h.groupChatId === "grp")!;
    expect(group).toMatchObject({ kind: "group", groupType: "roommates", budgetCents: 20000 });
    expect(group.members.map((m) => [m.name, m.role, m.canApprove ?? false])).toEqual([["Alex", "owner", false], ["Jake", "member", true]]);
  });

  it("family: kids join but can't approve", async () => {
    await inGroup(ALEX, "hi");
    expect(said(await inGroup(ALEX, "family"))).toMatch(/Usually a parent/);
    await inGroup(ALEX, "me");
    await inGroup(ALEX, "Mom");
    expect(said(await inGroup(ALEX, "no budget"))).toMatch(/Only Mom approves requests/);
    await inGroup(MAYA, "im maya");
    const group = [...db.households.values()].find((h) => h.groupChatId === "grp")!;
    expect(group.members.find((m) => m.name === "Maya")?.canApprove).toBeUndefined();
  });

  it("a personal space and a group can belong to the same person", async () => {
    for (const t of ["hi", "just me", "Alex", "no"]) await dm(ALEX, t);
    for (const t of ["hi", "roommates", "me", "Alex", "no"]) await inGroup(ALEX, t);
    expect(householdsForPhone(ALEX).map((h) => h.kind).sort()).toEqual(["group", "personal"]);
  });
});

it("a shopping text is not an answer to just me or group", async () => {
  await dm(ALEX, "hi");
  expect(said(await dm(ALEX, "we're out of TP"))).toMatch(/"just me" or "group"/);
  expect(householdsForPhone(ALEX)).toHaveLength(0);
});

it("only an exact \"me\" claims the card", async () => {
  await inGroup(ALEX, "hey");
  await inGroup(ALEX, "roommates");
  expect(await inGroup(ALEX, "tell me")).toHaveLength(0);
  expect(await inGroup(ALEX, "not me")).toHaveLength(0);
  expect(said(await inGroup(ALEX, "me"))).toMatch(/What should I call you\?/);
});

it("reads budgets and names the way people text them", () => {
  expect(parseBudget("150")).toBe(15000);
  expect(parseBudget("$1,200 a month")).toBe(120000);
  expect(parseBudget("nope")).toBeNull();
  expect(parseBudget("no")).toBeNull();
  expect(parseBudget("200 no problem")).toBe(20000);
  expect(parseBudget("no, 200")).toBe(20000);
  expect(parseBudget("whatever")).toBeUndefined();
  expect(nameFrom("I'm jake")).toBe("Jake");
  expect(nameFrom("call me Priya")).toBe("Priya");
  expect(nameFrom("123")).toBeUndefined();
});
