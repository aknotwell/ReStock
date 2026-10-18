// One-on-one from someone in several households: an add asks which household, then who it's for, then the usual
// "Which one?". Saying both up front ("order toilet paper for everyone for we da fam") skips the questions.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { seedDemo } from "../scripts/seed.js";
import { addItem, db, pendingItems } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { resetDestinations } from "../src/messaging/destination.js";
import { clearPendingChoices } from "../src/messaging/options.js";
import { payersOf } from "../src/messaging/splitWith.js";

const SAM = "+15550000001";
let logs: string[];
let n = 0;

async function say(text: string, spaceKind: "group" | "direct" = "direct") {
  const spaceId = spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${SAM}`;
  const msg = { messageId: `ad${++n}`, spaceId, spaceKind, fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}
const out = () => logs.join("\n");
const fam = () => db.households.get("fam-house")!;
const famItems = () => pendingItems("fam-house");
const payersIn = (itemName: RegExp) => {
  const item = famItems().find((i) => itemName.test(i.name))!;
  return payersOf(item, fam()).map((m) => m.name).sort();
};

beforeEach(async () => {
  seedDemo();
  for (const id of ["fam-house", "sam-personal"]) db.households.delete(id);
  for (const i of [...db.items.values()]) if (i.householdId !== "demo-house") db.items.delete(i.id);
  // Sam is also in "we da fam" with Alex.
  db.households.set("fam-house", {
    id: "fam-house", kind: "group", name: "we da fam", groupChatId: "pho_spc_fam", ownerId: "alex", spentCents: 0,
    members: [
      { id: "alex", name: "Alex", phone: "+15550000099", role: "owner" },
      { id: "sam-2", name: "Sam", phone: SAM, role: "member", canApprove: true }, // roommates can approve by default
    ],
  });
  addItem({ householdId: "fam-house", name: "Coffee beans", addedBy: "alex", cents: 1299, shared: true });
  clearPendingChoices();
  resetDestinations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await say("help", "group"); // binds the demo group chat
  logs = [];
});

describe("asking where it goes, then who it's for", () => {
  it("asks which household, then who it's for, then which one", async () => {
    await say("add oat milk");
    expect(out()).toMatch(/Which household is this for\?\n1\. Your household \(you, Jake and Priya\)\n2\. we da fam \(Alex and you\)\nReply with a number or name, or "cancel"\./);
    logs = [];
    await say("2");
    expect(out()).toMatch(/Who's it for in we da fam \(Alex and you\)\? Reply "everyone", "just me", or names like "me and Alex"\./);
    logs = [];
    await say("just me");
    expect(out()).toMatch(/Which one\?\n1\./);
    await say("2"); // plain oat milk
    expect(out()).toMatch(/Added Oat milk to we da fam/);
    expect(payersIn(/Oat milk/)).toEqual(["Sam"]);
    expect(pendingItems("demo-house").filter((i) => /Oat milk/.test(i.name) && i.addedBy !== "sam")).toHaveLength(0);
  });

  it("the household can be picked by name, and 'everyone' splits it with everyone", async () => {
    await say("add oat milk");
    await say("we da fam");
    await say("everyone");
    await say("2");
    expect(payersIn(/Oat milk/)).toEqual(["Alex", "Sam"]);
  });

  it("names it asks about are checked: an unknown name asks again", async () => {
    await say("add oat milk");
    await say("2");
    logs = [];
    await say("me and Bob");
    expect(out()).toMatch(/I don't know who that is in we da fam/);
    logs = [];
    await say("me and Alex");
    expect(out()).toMatch(/Which one\?/);
  });

  it("'cancel' adds nothing", async () => {
    const before = famItems().length;
    await say("add oat milk");
    await say("cancel");
    expect(out()).toMatch(/OK, I didn't add it\./);
    expect(famItems()).toHaveLength(before);
  });

  it("a different message instead of an answer moves on", async () => {
    await say("add oat milk");
    logs = [];
    await say("what do I owe?");
    expect(out()).not.toMatch(/Which household|Reply with a number/);
  });
});

describe("saying it all at once", () => {
  it("'order toilet paper for everyone for we da fam' asks nothing before 'Which one?'", async () => {
    await say("order toilet paper for everyone for we da fam");
    expect(out()).not.toMatch(/Which household|Who's it for/);
    expect(out()).toMatch(/Which one\?\n1\./);
    await say("1");
    expect(payersIn(/Toilet paper/)).toEqual(["Alex", "Sam"]);
  });

  it("'add chips for me and Alex in we da fam' splits between them", async () => {
    await say("add tortilla chips for me and Alex in we da fam");
    expect(out()).not.toMatch(/Which household|Who's it for/);
    if (/Which one\?/.test(out())) await say("1");
    expect(payersIn(/chips/i)).toEqual(["Alex", "Sam"]);
  });

  it("naming only the household still asks who it's for", async () => {
    await say("add oat milk to we da fam");
    expect(out()).not.toMatch(/Which household/);
    expect(out()).toMatch(/Who's it for in we da fam/);
  });

  it("their personal list is one of the choices, and needs no split question", async () => {
    db.households.set("sam-personal", {
      id: "sam-personal", kind: "personal", groupChatId: `personal:${SAM}`, ownerId: "sam-p", spentCents: 0,
      members: [{ id: "sam-p", name: "Sam", phone: SAM, role: "owner" }],
    });
    await say("add oat milk");
    expect(out()).toMatch(/\d\. Your personal list/);
    logs = [];
    await say("personal");
    expect(out()).not.toMatch(/Who's it for/);
    expect(out()).toMatch(/Which one\?/);
  });
});

describe("unchanged", () => {
  it("in a group chat, adds go to that group's cart without questions", async () => {
    await say("add oat milk", "group");
    expect(out()).not.toMatch(/Which household|Who's it for/);
    expect(out()).toMatch(/Which one\?/);
  });
});
