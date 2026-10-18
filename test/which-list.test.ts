// "shopping list" one-on-one from someone in two groups asks which group's list, then shows only that one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { addItem, db } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";

const SAM = "+15550000001";
let logs: string[];
let n = 0;

async function say(text: string, spaceKind: "group" | "direct" = "direct") {
  const spaceId = spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${SAM}`;
  const msg = { messageId: `wl${++n}`, spaceId, spaceKind, fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}
const out = () => logs.join("\n");

/** Sam is also in Alex's household (a second group, with its own group chat). */
function addSecondHousehold() {
  db.households.set("alex-house", {
    id: "alex-house",
    kind: "group",
    groupChatId: "pho_spc_alex",
    ownerId: "alex",
    spentCents: 0,
    members: [
      { id: "alex", name: "Alex", phone: "+15550000099", role: "owner" },
      { id: "sam-2", name: "Sam", phone: SAM, role: "member" },
    ],
  });
  addItem({ householdId: "alex-house", name: "Coffee beans", addedBy: "alex", cents: 1299, shared: true });
}

beforeEach(async () => {
  seedDemo();
  db.households.delete("alex-house");
  for (const i of [...db.items.values()]) if (i.householdId === "alex-house") db.items.delete(i.id);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await say("help", "group"); // binds the demo group chat
  logs = [];
});

describe("which shopping list", () => {
  it("asks which group, and a pick shows only that group's items", async () => {
    addSecondHousehold();
    await say("shopping list");
    expect(out()).toMatch(/Which list\?\n1\. Your household \(you, Jake and Priya\)\n2\. Alex's household \(Alex and you\)\nReply with a number, or "cancel"\./);
    expect(out()).not.toMatch(/In the cart/);
    logs = [];
    await say("2");
    expect(out()).toMatch(/Alex's household \(Alex and you\):\nIn the cart \(1 item\):[\s\S]*Coffee beans, \$12\.99/);
    expect(out()).not.toMatch(/Toilet paper|Oat milk/);
    logs = [];
    await say("2"); // the question is answered, so "2" isn't a pick any more
    expect(out()).not.toMatch(/In the cart/);
  });

  it("accepts the owner's name as the pick", async () => {
    addSecondHousehold();
    await say("cart");
    logs = [];
    await say("Alex's");
    expect(out()).toMatch(/Coffee beans/);
  });

  it("asks again for a number that isn't on the list", async () => {
    addSecondHousehold();
    await say("cart");
    logs = [];
    await say("3");
    expect(out()).toMatch(/Reply with a number from 1 to 2, or "cancel"/);
    logs = [];
    await say("1");
    expect(out()).toMatch(/Your household[\s\S]*Toilet paper/);
    expect(out()).not.toMatch(/Coffee beans/);
  });

  it("cancel drops the question", async () => {
    addSecondHousehold();
    await say("what's in the cart?");
    logs = [];
    await say("cancel");
    expect(out()).toMatch(/OK, never mind\./);
    logs = [];
    await say("1");
    expect(out()).not.toMatch(/In the cart/);
  });

  it("never lists a group the sender isn't in", async () => {
    addSecondHousehold();
    db.households.set("stranger-house", {
      id: "stranger-house", kind: "group", groupChatId: "pho_spc_x", ownerId: "zoe", spentCents: 0,
      members: [{ id: "zoe", name: "Zoe", phone: "+15550000077", role: "owner" }],
    });
    await say("cart");
    expect(out()).not.toMatch(/Zoe/);
    db.households.delete("stranger-house");
  });

  it("a group chat shows that group's list without asking", async () => {
    addSecondHousehold();
    await say("shopping list", "group");
    expect(out()).not.toMatch(/Which list/);
    expect(out()).toMatch(/In the cart \(6 items\)/);
  });

  it("with only one group, shows the list without asking", async () => {
    await say("shopping list");
    expect(out()).not.toMatch(/Which list/);
    expect(out()).toMatch(/In the cart \(6 items\)/);
  });
});

describe("a household with its own name", () => {
  it("is listed by that name, can be picked by it, and the order preview uses it", async () => {
    addSecondHousehold();
    db.households.get("alex-house")!.name = "we da fam";
    await say("shopping list");
    expect(out()).toMatch(/Which list\?\n1\. Your household \(you, Jake and Priya\)\n2\. we da fam \(Alex and you\)\n/);
    expect(out()).not.toMatch(/Alex's household/);
    logs = [];
    await say("we da fam");
    expect(out()).toMatch(/we da fam \(Alex and you\):\nIn the cart \(1 item\)/);
    logs = [];
    await say("order now");
    expect(out()).toMatch(/Which cart should I order\?\n1\. Your household \(you, Jake and Priya\)\n2\. we da fam \(Alex and you\)/);
    logs = [];
    await say("2");
    expect(out()).not.toMatch(/Alex's household/);
    expect(out()).toMatch(/we da fam \(Alex and you\)/);
  });
});

