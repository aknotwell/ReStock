// One phone in several households: start another one, list them, switch where one-on-one texts go, leave one,
// and create a group from the dashboard. Which household a text belongs to is decided in code, never the model.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activeHousehold, addMember, createHousehold, findMyHousehold, householdName, shareCard, stripeCustomerInUse } from "../src/core/households.js";
import { pendingCustomerDeletions } from "../src/payments/deleteCustomer.js";
import { addItem, db, householdsForPhone, pendingItems, resetStore } from "../src/core/store.js";
import { parseMembershipCommand } from "../src/messaging/membership.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound, resetMuted } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";
import { inviteCodeFor, inviteCodeIn, resetSignups } from "../src/core/signups.js";
import { resetPayBack } from "../src/payments/payback.js";
import { webRoutes } from "../src/web/routes.js";

const ALEX = "+14255550101", AMBER = "+14255550102", BEA = "+15095550103";
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string, agentLine?: string) {
  const msg = { messageId: `mh${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent", ...(agentLine ? { agentLine } : {}) };
  rememberInbound(msg);
  await handleInbound(msg);
}

/** "add …", picking the first option if Restock offers a choice. */
async function add(from: string, text: string) {
  logs = [];
  await dm(from, text);
  if (/Reply 1|reply 1|\n1\. /i.test(out())) await dm(from, "1");
}

beforeEach(() => {
  resetStore();
  resetSignups();
  resetPayBack();
  resetMuted();
  resetConfirmations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parsing", () => {
  it("reads household commands without stealing item changes", () => {
    expect(parseMembershipCommand("new group called Soccer Team")).toEqual({ type: "start", name: null, householdName: "Soccer Team" });
    expect(parseMembershipCommand("create another household named Maple House as Alex")).toEqual({ type: "start", name: "Alex", householdName: "Maple House" });
    expect(parseMembershipCommand("households")).toEqual({ type: "households" });
    expect(parseMembershipCommand("my groups?")).toEqual({ type: "households" });
    expect(parseMembershipCommand("switch to Maple House")).toEqual({ type: "switch", query: "Maple House" });
    expect(parseMembershipCommand("rename household Maple House")).toEqual({ type: "rename", name: "Maple House" });
    expect(parseMembershipCommand("leave household")).toEqual({ type: "leave" });
    expect(parseMembershipCommand("delete my data")).toEqual({ type: "delete_self" });
    expect(parseMembershipCommand("switch the chips to personal")).toBeUndefined();
  });

  it("finds one of your households by name, part of it, or its number", () => {
    const a = createHousehold("Alex", ALEX, { name: "Maple House" });
    const b = createHousehold("Alex", ALEX);
    expect(findMyHousehold(ALEX, "maple house")?.id).toBe(a.id);
    expect(findMyHousehold(ALEX, "the maple household")?.id).toBe(a.id);
    expect(findMyHousehold(ALEX, "2")?.id).toBe(b.id);
    expect(findMyHousehold(ALEX, "Alex")?.id).toBe(b.id); // "Alex's household"
    expect(findMyHousehold(ALEX, "oat milk")).toBeUndefined();
    expect(findMyHousehold(AMBER, "maple")).toBeUndefined(); // only your own households
  });
});

describe("over text", () => {
  it("starts a second household, lists both, and switches where texts go", async () => {
    await dm(ALEX, "start household as Alex");
    await dm(ALEX, "rename household Maple House");
    const maple = householdsForPhone(ALEX)[0]!;
    expect(maple.name).toBe("Maple House");

    logs = [];
    await dm(ALEX, "new group called Soccer Team");
    expect(out()).toMatch(/You started Soccer Team[\s\S]*Texts to me now go to Soccer Team/);
    const soccer = householdsForPhone(ALEX)[1]!;
    expect(soccer.members[0]).toMatchObject({ name: "Alex", role: "owner" }); // remembered her name
    expect(soccer.members[0]!.id).not.toBe(maple.members[0]!.id); // her own record (and card) per household

    await add(ALEX, "add dish soap");
    expect(pendingItems(soccer.id)).toHaveLength(1);
    expect(pendingItems(maple.id)).toHaveLength(0);

    logs = [];
    await dm(ALEX, "households");
    expect(out()).toMatch(/1\. Maple House\n2\. Soccer Team \(texts here go to this one\)/);

    logs = [];
    await dm(ALEX, "switch to maple");
    expect(out()).toMatch(/Switched to Maple House\. Texts to me now go there\. Its cart is empty\./);
    await add(ALEX, "add paper towels");
    expect(pendingItems(maple.id)).toHaveLength(1);
    expect(pendingItems(soccer.id)).toHaveLength(1);
  });

  it("an unknown household name falls through instead of being swallowed", async () => {
    await dm(ALEX, "start household as Alex");
    logs = [];
    await dm(ALEX, "switch to the beach household");
    expect(out()).toMatch(/couldn't find that one[\s\S]*1\. Alex's household/);
  });

  it("labels private texts with the household when someone is in more than one", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    addMember(maple, "Amber", AMBER);
    createHousehold("Amber", AMBER, { name: "Book Club" }); // Amber is in two; her texts now go to Book Club
    await dm(AMBER, "hi"); // so Restock can text her privately
    await add(ALEX, "add dish soap");
    expect(out()).toMatch(/Maple House: Alex added Dish soap/); // relayed to Amber, labeled
    expect(out()).not.toMatch(/Maple House: Added/); // Alex is in one household: no label
  });

  it("a \"yes\" to an approval from another household approves it there", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const amber = addMember(maple, "Amber", AMBER);
    const club = createHousehold("Bea", BEA, { name: "Book Club" });
    addMember(club, "Alex", ALEX); // Alex's texts now go to Book Club
    const item = addItem({ householdId: maple.id, name: "Air fryer", addedBy: amber.id, cents: 3200, shared: false, needsApproval: true });
    logs = [];
    await dm(ALEX, "yes");
    expect(out()).toMatch(/Approved by Alex: Air fryer/);
    expect(item.needsApproval).toBe(false);
    expect(activeHousehold(ALEX)?.id).toBe(club.id); // didn't switch her
  });

  it("leaving one household keeps the others (and the Restock number)", async () => {
    await dm(ALEX, "start household as Alex");
    await dm(ALEX, "new household called Soccer Team");
    logs = [];
    await dm(ALEX, "leave household");
    expect(out()).toMatch(/Leave Soccer Team\?/);
    await dm(ALEX, "switch to 1"); // switching meanwhile doesn't change which one the "yes" leaves
    await dm(ALEX, "yes");
    expect(out()).toMatch(/You've left Soccer Team[\s\S]*Texts to me now go to Alex's household/);
    expect(householdsForPhone(ALEX).map(householdName)).toEqual(["Alex's household"]);
  });

  it("\"delete my data\" leaves every household", async () => {
    await dm(ALEX, "start household as Alex");
    await dm(ALEX, "new household called Soccer Team");
    logs = [];
    await dm(ALEX, "delete my data");
    expect(out()).toMatch(/all your households[\s\S]*"leave household"/);
    await dm(ALEX, "yes");
    expect(householdsForPhone(ALEX)).toHaveLength(0);
  });
});

describe("joining another household with an invite, without signing up again", () => {
  it("reads the code from \"join <code>\" or a pasted invite link", () => {
    expect(inviteCodeIn("join abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(inviteCodeIn("Join https://restock.example/join/abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(inviteCodeIn("join the household")).toBeUndefined();
  });

  it("someone who already uses Restock texts \"join <code>\" and is in, under the name they use", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const club = createHousehold("Amber", AMBER, { name: "Book Club" });
    addMember(club, "Alex", ALEX); // a different Alex: Amber's joiner below can't reuse the name
    await dm(AMBER, "hi");
    logs = [];
    await dm(AMBER, `join http://localhost:3000/join/${inviteCodeFor(maple, maple.ownerId)}`);
    expect(out()).toMatch(/Welcome, Amber! You're in Maple House\. Texts to me now go there/);
    expect(maple.members.map((m) => m.name)).toEqual(["Alex", "Amber"]);
    expect(activeHousehold(AMBER)?.id).toBe(maple.id);
    expect(out()).toMatch(/Amber joined the household/); // relayed to Alex

    logs = [];
    await dm(AMBER, `join ${inviteCodeFor(maple, maple.ownerId)}`);
    expect(out()).toMatch(/You're already in Maple House/);
  });

  it("a name already in the household gets a number instead of a question", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    createHousehold("Alex", BEA, { name: "Other" }); // another Alex, on another phone
    await dm(BEA, `join ${inviteCodeFor(maple, maple.ownerId)}`);
    expect(maple.members.map((m) => m.name)).toEqual(["Alex", "Alex 2"]);
  });

  it("someone new is sent to the sign-up page", async () => {
    const maple = createHousehold("Alex", ALEX);
    const code = inviteCodeFor(maple, maple.ownerId);
    logs = [];
    await dm(BEA, `join ${code}`);
    expect(out()).toContain(`Open the invite link to sign up first: http://localhost:3000/join/${code}`);
    expect(maple.members).toHaveLength(1);
  });
});

describe("dashboard New group", () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = express().use(express.json()).use(webRoutes).listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  async function login(handle: string): Promise<string> {
    await post("/pay/api/start", { handle });
    const code = /Your Restock code is (\d{6})/.exec(out())?.[1];
    const res = await post("/pay/api/verify", { handle, code });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  it("creates a household owned by the logged-in person, with an invite link", async () => {
    createHousehold("Alex", ALEX);
    await dm(ALEX, "hi");
    const cookie = await login(ALEX);
    const res = await post("/app/api/households", { name: "Garcia Family", groupType: "family", budgetCents: 15000 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.space.household).toMatchObject({ name: "Garcia Family", kind: "group", groupType: "family", budgetCents: 15000 });
    expect(body.space.me).toMatchObject({ name: "Alex", role: "owner", cardLast4: null });
    expect(body.inviteUrl).toMatch(/\/join\/[A-Za-z0-9_-]{16}$/);

    const spaces = await (await fetch(`${base}/app/api/spaces`, { headers: { cookie } })).json();
    expect(spaces.spaces.map((s: { household: { name: string } }) => s.household.name)).toEqual(["Alex's household", "Garcia Family"]);

    // The invite button works per household: this one's link, not the first one's.
    const invite = await (await post("/app/api/invite", { memberId: body.space.me.id }, cookie)).json();
    expect(invite.url).toBe(body.inviteUrl);
  });

  it("the invite page offers a logged-in person a one-tap join", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const code = inviteCodeFor(maple, maple.ownerId);
    createHousehold("Amber", AMBER);
    await dm(AMBER, "hi", "+16285550111"); // she texts Restock on her own Restock number
    expect((await post("/signup/api/join", { inviteCode: code })).status).toBe(401); // not logged in

    const cookie = await login(AMBER);
    const info = await (await fetch(`${base}/signup/api/invite/${code}`, { headers: { cookie } })).json();
    expect(info).toMatchObject({ householdName: "Maple House", joinAs: { name: "Amber" }, alreadyIn: false });
    expect(JSON.stringify(info)).not.toContain(AMBER); // no phone numbers on the page

    const res = await post("/signup/api/join", { inviteCode: code }, cookie);
    expect(res.status).toBe(200);
    // Her own Restock number comes back, so "Open Messages" is addressed to it.
    expect(await res.json()).toEqual({ householdName: "Maple House", name: "Amber", line: "+16285550111", smsLink: "sms:+16285550111" });
    expect(maple.members.map((m) => m.name)).toEqual(["Alex", "Amber"]);
    const again = await (await fetch(`${base}/signup/api/invite/${code}`, { headers: { cookie } })).json();
    expect(again).toMatchObject({ joinAs: null, alreadyIn: true });
    expect((await post("/signup/api/join", { inviteCode: "x".repeat(16) }, cookie)).status).toBe(400);
  });

  it("\"Already use Restock?\" finds your Restock number from your phone number, without logging in", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const code = inviteCodeFor(maple, maple.ownerId);
    createHousehold("Amber", AMBER); // started by texting Restock, never signed up on the web
    await dm(AMBER, "hi", "+16285550111");

    const res = await post("/signup/api/my-line", { inviteCode: code, phone: "(425) 555-0102" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      line: "+16285550111",
      joinText: `join ${code}`,
      smsLink: `sms:+16285550111&body=join%20${code}`,
    });
    expect(maple.members).toHaveLength(1); // nothing joins until she texts it from her phone

    expect((await post("/signup/api/my-line", { inviteCode: code, phone: "509-555-0103" })).status).toBe(404); // not a Restock user
    expect((await post("/signup/api/my-line", { inviteCode: code, phone: "425-555-0101" })).status).toBe(400); // already in it
    expect((await post("/signup/api/my-line", { inviteCode: "x".repeat(16), phone: "425-555-0102" })).status).toBe(404); // bad invite
    expect((await post("/signup/api/my-line", { inviteCode: code, phone: "12" })).status).toBe(400);

    // Then her text to that number joins her.
    logs = [];
    await dm(AMBER, `join ${code}`, "+16285550111");
    expect(out()).toMatch(/Welcome, Amber! You're in Maple House/);
  });

  it("checks the input and needs a login", async () => {
    expect((await post("/app/api/households", { name: "X", groupType: "roommates" })).status).toBe(401);
    createHousehold("Alex", ALEX);
    await dm(ALEX, "hi");
    const cookie = await login(ALEX);
    expect((await post("/app/api/households", { name: "<script>", groupType: "roommates" }, cookie)).status).toBe(400);
    expect((await post("/app/api/households", { name: "Maple", groupType: "coven" }, cookie)).status).toBe(400);
    expect((await post("/app/api/households", { name: "Maple", groupType: "other", budgetCents: 12.5 }, cookie)).status).toBe(400);
    expect((await post("/app/api/households", { name: "Maple", groupType: "other", budgetCents: null }, cookie)).status).toBe(200);
    expect(db.households.size).toBe(2);
  });
});

describe("one card per person across households", () => {
  const giveCard = (household: ReturnType<typeof createHousehold>, phone: string) =>
    Object.assign(household.members.find((m) => m.phone === phone)!, { stripeCustomerId: "cus_alex", paymentMethodId: "pm_alex", cardLast4: "4242" });

  it("\"order now\" in another household uses the card you added in your first one", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const soccer = createHousehold("Alex", ALEX, { name: "Soccer Team" }); // texts now go here
    giveCard(maple, ALEX); // added from the dashboard while looking at Maple House (an existing record, not shared yet)
    await add(ALEX, "add dish soap");
    logs = [];
    await dm(ALEX, "order now");
    if (/Which cart/.test(out())) await dm(ALEX, "2"); // Soccer Team
    // Past the owner-card check, it goes on to charge her card through Stripe (no key in tests, so that throws).
    const charging = /Reply "yes" to order/.test(out()) ? await dm(ALEX, "yes").catch((err: Error) => err) : undefined;
    expect(out()).not.toMatch(/I need your card/);
    expect(String(charging)).toMatch(/STRIPE_SECRET_KEY/);
    expect(soccer.members[0]).toMatchObject({ paymentMethodId: "pm_alex", cardLast4: "4242", stripeCustomerId: "cus_alex" });
  });

  it("a new card is shared with your other households right away, and new ones start with it", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const soccer = createHousehold("Alex", ALEX, { name: "Soccer Team" });
    shareCard(giveCard(maple, ALEX));
    expect(soccer.members[0]!.cardLast4).toBe("4242");
    const club = createHousehold("Amber", AMBER, { name: "Book Club" });
    expect(addMember(club, "Alex", ALEX).paymentMethodId).toBe("pm_alex");
    expect(createHousehold("Alex", ALEX, { name: "Family" }).members[0]!.paymentMethodId).toBe("pm_alex");
  });

  it("a card you added in a household is kept there, not replaced by another household's", () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const soccer = createHousehold("Alex", ALEX, { name: "Soccer Team" });
    giveCard(maple, ALEX);
    Object.assign(soccer.members[0]!, { stripeCustomerId: "cus_other", paymentMethodId: "pm_other", cardLast4: "1881" });
    shareCard(maple.members[0]!);
    expect(soccer.members[0]!.cardLast4).toBe("1881");
  });

  it("leaving one household keeps the Stripe customer the others still use", async () => {
    createHousehold("Alex", ALEX, { name: "Maple House" });
    const soccer = createHousehold("Alex", ALEX, { name: "Soccer Team" });
    shareCard(giveCard(soccer, ALEX));
    await dm(ALEX, "leave household"); // leaves Soccer Team, the active one
    await dm(ALEX, "yes");
    expect(householdsForPhone(ALEX).map(householdName)).toEqual(["Maple House"]);
    expect(stripeCustomerInUse("cus_alex")).toBe(true);
    expect(pendingCustomerDeletions()).not.toContain("cus_alex");
  });
});
