// "invite" only ever goes to a group household the sender owns: never their personal list, a plain error for
// non-owners, and "Which household?" for someone who owns several.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { setActiveHousehold } from "../src/core/households.js";
import { householdForInvite, invitedTo, resetSignups } from "../src/core/signups.js";
import { db, resetStore } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import type { Household } from "../src/types.js";

const ME = "+14255550111";
let logs: string[];
let n = 0;
const out = () => logs.join("\n");

async function dm(text: string) {
  const msg = { messageId: `it${++n}`, spaceId: `pho_spc_dm_${ME}`, spaceKind: "direct" as const, fromPhone: ME, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

function group(id: string, name: string, ownerName: string, iOwn: boolean): Household {
  const owner = iOwn ? { id: `${id}-me`, name: "Alexander", phone: ME, role: "owner" as const } : { id: `${id}-o`, name: ownerName, phone: `+1206555${String(n++).padStart(4, "0")}`, role: "owner" as const };
  const members = iOwn ? [owner] : [owner, { id: `${id}-me`, name: "Alexander", phone: ME, role: "member" as const }];
  const h: Household = { id, kind: "group", name, groupChatId: `pho_spc_${id}`, ownerId: owner.id, spentCents: 0, members };
  db.households.set(id, h);
  return h;
}
function personal(): Household {
  const h: Household = { id: "mine", kind: "personal", groupChatId: `personal:${ME}`, ownerId: "mine-me", spentCents: 0, members: [{ id: "mine-me", name: "Alexander", phone: ME, role: "owner" }] };
  db.households.set(h.id, h);
  setActiveHousehold(ME, h.id); // their texts go to their personal list
  return h;
}
const linkCode = () => /\/join\/([A-Za-z0-9_-]+)/.exec(out())?.[1];

beforeEach(() => {
  resetStore();
  resetSignups();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("invite from someone who doesn't own the household", () => {
  it("is refused with who to ask, instead of making a link for their personal list", async () => {
    group("amber-house", "Amber's place", "Amber", false);
    personal();
    await dm("invite");
    expect(out()).toMatch(/Only the budget owner can invite people\. Ask Amber for the invite link\./);
    expect(out()).not.toMatch(/Your invite link/);
  });

  it("names each household's owner when they're in several", async () => {
    group("amber-house", "Amber's place", "Amber", false);
    group("fam-house", "we da fam", "David", false);
    await dm("invite");
    expect(out()).toMatch(/Ask Amber for Amber's place, or David for we da fam for the invite link\./);
  });

  it("someone with only a personal list is told it's just for them", async () => {
    personal();
    await dm("invite");
    expect(out()).toMatch(/Your personal list is just for you, so there's no one to invite/);
  });

  it("inviting someone by phone is refused the same way", async () => {
    group("amber-house", "Amber's place", "Amber", false);
    personal();
    await dm("invite Eve 206-555-0177");
    expect(out()).toMatch(/Only the budget owner can invite or remove people\. Ask Amber to invite them\./);
    expect(invitedTo("mine")).toEqual([]);
  });
});

describe("invite from an owner", () => {
  it("one household they own: the link is for it, even while their texts go to their personal list", async () => {
    group("fam-house", "we da fam", "", true);
    personal();
    await dm("invite");
    expect(out()).toMatch(/Your invite link: .*\/join\//);
    expect(householdForInvite(linkCode()!)?.id).toBe("fam-house");
  });

  it("several households they own: asks which, then makes the link for that one", async () => {
    group("fam-house", "we da fam", "", true);
    group("soccer", "Soccer Team", "", true);
    await dm("invite");
    expect(out()).toMatch(/Which household should I make an invite link for\?\n1\. we da fam \(you\)\n2\. Soccer Team \(you\)\nReply with a number, or "cancel"\./);
    expect(out()).not.toMatch(/Your invite link/);
    logs = [];
    await dm("2");
    expect(householdForInvite(linkCode()!)?.id).toBe("soccer");
  });

  it("several households they own: 'invite Eve <phone>' asks which, then invites her there", async () => {
    group("fam-house", "we da fam", "", true);
    group("soccer", "Soccer Team", "", true);
    await dm("invite Eve 206-555-0177");
    expect(out()).toMatch(/Which household should I invite Eve to\?/);
    await dm("we da fam");
    expect(invitedTo("fam-house").map((p) => p.name)).toEqual(["Eve"]);
    expect(invitedTo("soccer")).toEqual([]);
  });
});
