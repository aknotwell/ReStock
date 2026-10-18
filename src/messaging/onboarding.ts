// First contact: Restock introduces itself and sets up a space by asking questions.
//
// - Someone texts Restock one-on-one and isn't set up yet: say hi, explain what Restock does, and ask
//   whether it's just for them or for a group. "Just me" makes a personal space (name, then an optional
//   monthly budget). "Group" sets up a household the same way and gives them an invite link for the others:
//   on Photon's shared lines everyone texts their own Restock number, so a single group chat can't include
//   Restock for everyone. Household news is relayed to each member's own thread.
// - Restock gets a message in a group chat it doesn't know: say hi to everyone and ask what kind of group
//   it is. Roommates means everyone can approve requests; family means only the main card does.
//   Whoever replies "me" is the main card, then their name and an optional budget finish the setup.
// - In a set-up group, someone new texts "I'm Jake" to join.
//
// Every step is plain code: the answers decide the setup, the model never does. Answers are matched
// loosely ("just me", "it's just me", "personal") so it reads like a conversation.
import { config } from "../config.js";
import { allMemberIds, atSpaceLimit, cleanName, memberId, setActiveHousehold, TOO_MANY_SPACES } from "../core/households.js";
import { registerState } from "../core/persist.js";
import { db, householdsForPhone, newId, UNBOUND_GROUP } from "../core/store.js";
import { inviteCodeFor } from "../core/signups.js";
import { createCardSetupLink } from "../payments/links.js";
import type { Cents, Household, Member } from "../types.js";
import { sendPrivate, type InboundMessage } from "./photon.js";
import { fmt } from "./templates.js";

type GroupType = NonNullable<Household["groupType"]>;
type Setup =
  | { flow: "direct"; step: "kind" | "name" | "budget"; space?: "personal" | "group"; name?: string; expires: number }
  | { flow: "group"; step: "type" | "owner" | "name" | "budget"; groupType?: GroupType; ownerPhone?: string; name?: string; expires: number };

/** Unfinished setups expire after a day, so an old "hi" doesn't leave a chat stuck halfway. */
export const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const setups = new Map<string, Setup>(); // "dm:<phone>" or "group:<spaceId>"
registerState("onboarding", {
  dump: () => [...setups],
  load: (data) => {
    setups.clear();
    for (const [k, s] of data as [string, Setup][]) if (s.expires > Date.now()) setups.set(k, s);
  },
});

const dashboardLink = () => `${config.publicBaseUrl}/dashboard`;

export const GREETING_DIRECT =
  "Hi! I'm Restock, an AI assistant (not a person). Text me what you're out of and I'll find the best match, keep a cart, and only order when you text \"order now\".\n" +
  "Is this just for you, or for a group? Reply \"just me\" or \"group\".";

export const GREETING_GROUP =
  "Hi everyone! I'm Restock, an AI assistant (not a person). Tell me what you're out of and I'll find the best match, keep a shared cart, and only order when someone texts \"order now\".\n" +
  "First, who's this group? Reply \"roommates\", \"family\", or \"other\".";

const said = (text: string, ...words: string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`, "i").test(text);

/** "150", "$150", "150 a month" -> cents; "no", "no budget", "none", "skip" -> null; anything else -> undefined. */
export function parseBudget(text: string): Cents | null | undefined {
  if (said(text, "no", "none", "skip", "nope", "no budget", "no limit", "unlimited")) return null;
  const m = /\$?\s*(\d{1,5}(?:\.\d{1,2})?)/.exec(text.replace(/,/g, ""));
  if (!m?.[1]) return undefined;
  const cents = Math.round(Number(m[1]) * 100);
  return cents > 0 ? cents : null;
}

/** The name in "I'm Jake", "im jake", "this is Jake", "call me Jake", or just "Jake". */
export function nameFrom(text: string): string | undefined {
  const t = text.trim().replace(/[.!]+$/, "");
  const m = /^(?:hi[,!]?\s+)?(?:i'?m|i am|it'?s|this is|call me|my name is|name'?s)\s+(.+)$/i.exec(t);
  const raw = (m?.[1] ?? t).trim();
  const name = cleanName(raw);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

const budgetLine = (cents: Cents | null) => (cents === null ? "No monthly budget." : `Monthly budget: ${fmt(cents)}.`);

function newSpace(kind: "personal" | "group", owner: Member, budget: Cents | null, extra: Partial<Household> = {}): Household {
  const household: Household = {
    id: newId(),
    kind,
    groupChatId: extra.groupChatId ?? `personal:${owner.phone}`,
    ownerId: owner.id,
    spentCents: 0,
    members: [owner],
    ...(budget === null ? {} : { budgetCents: budget }),
    ...extra,
  };
  db.households.set(household.id, household);
  setActiveHousehold(owner.phone, household.id);
  return household;
}

type Ctx = { msg: InboundMessage; household: Household | undefined; respond: (text: string) => Promise<void> };

/** Is Restock in the middle of asking setup questions in this chat? */
export function setupInProgress(msg: InboundMessage): boolean {
  const s = setups.get(msg.spaceKind === "direct" ? `dm:${msg.fromPhone}` : `group:${msg.spaceId}`);
  return !!s && s.expires > Date.now();
}

/**
 * Handles a message from someone Restock can't place yet. Returns true if it replied.
 * Called by the inbound pipeline after guardrails and membership commands.
 */
export async function handleOnboarding({ msg, household, respond }: Ctx): Promise<boolean> {
  if (msg.spaceKind === "direct") return direct(msg, respond);
  if (!household) return group(msg, respond);
  return join(msg, household, respond);
}

async function direct(msg: InboundMessage, respond: Ctx["respond"]): Promise<boolean> {
  const key = `dm:${msg.fromPhone}`;
  const setup = setups.get(key);
  const text = msg.text.trim();
  const expires = Date.now() + SETUP_TTL_MS;

  if (!setup || setup.flow !== "direct" || setup.expires < Date.now()) {
    setups.set(key, { flow: "direct", step: "kind", expires });
    await respond(GREETING_DIRECT);
    return true;
  }
  if (setup.step === "kind") {
    if (said(text, "group", "roommates?", "family", "friends", "team", "us", "we")) {
      setups.set(key, { ...setup, step: "name", space: "group", expires });
      await respond("Great, I'll set up your group and you'll be the one whose card pays. What should I call you?");
    } else if (said(text, "me", "just me", "myself", "personal", "solo", "only me", "mine", "yes")) {
      setups.set(key, { ...setup, step: "name", expires });
      await respond("Nice. What should I call you?");
    } else {
      await respond('Just reply "just me" or "group".');
    }
    return true;
  }
  if (setup.step === "name") {
    const name = nameFrom(text);
    if (!name) {
      await respond("What should I call you? Your first name is fine.");
      return true;
    }
    setups.set(key, { ...setup, step: "budget", name, expires });
    await respond(`Hi ${name}! Want a monthly budget? Reply an amount like 150, or "no budget".`);
    return true;
  }
  // step === "budget"
  const budget = parseBudget(text);
  if (budget === undefined) {
    await respond('Reply an amount like 150, or "no budget".');
    return true;
  }
  setups.delete(key);
  if (setup.space === "group") {
    if (atSpaceLimit(msg.fromPhone)) {
      await respond(TOO_MANY_SPACES);
      return true;
    }
    const owner: Member = { id: memberId(setup.name!, allMemberIds()), name: setup.name!, phone: msg.fromPhone, role: "owner" };
    const household = newSpace("group", owner, budget, { groupChatId: UNBOUND_GROUP, groupType: "roommates" });
    await respond(
      `You're set up, ${owner.name}! ${budgetLine(budget)}\n` +
        `Invite everyone with this link. Each person signs up and gets their own Restock number: ${config.publicBaseUrl}/join/${inviteCodeFor(household, owner.id)}\n` +
        `Add the main card so orders can go through. It opens Stripe's secure page; I never see the number: ${await createCardSetupLink(owner.id)}\n` +
        'Try it: text "we\'re out of TP".',
    );
    return true;
  }
  if (householdsForPhone(msg.fromPhone).some((h) => h.kind === "personal")) {
    await respond("You already have a personal space with me. Text what you need, like \"we're out of coffee\".");
    return true;
  }
  const owner: Member = { id: memberId(setup.name!, allMemberIds()), name: setup.name!, phone: msg.fromPhone, role: "owner" };
  newSpace("personal", owner, budget);
  await respond(
    `You're set up, ${owner.name}. ${budgetLine(budget)}\n` +
      `Add a card so I can pay for orders. It opens Stripe's secure page; I never see the number: ${await createCardSetupLink(owner.id)}\n` +
      `Log in to see your cart and settings: ${dashboardLink()}\n` +
      'Try it: text "we\'re out of coffee".',
  );
  return true;
}

async function group(msg: InboundMessage, respond: Ctx["respond"]): Promise<boolean> {
  const key = `group:${msg.spaceId}`;
  const setup = setups.get(key);
  const text = msg.text.trim();
  const expires = Date.now() + SETUP_TTL_MS;

  if (!setup || setup.flow !== "group" || setup.expires < Date.now()) {
    setups.set(key, { flow: "group", step: "type", expires });
    await respond(GREETING_GROUP);
    return true;
  }
  if (setup.step === "type") {
    const groupType: GroupType | undefined = said(text, "roommates?", "roomies", "housemates?", "flatmates?", "apartment", "house")
      ? "roommates"
      : said(text, "family", "fam", "parents", "kids", "home") ? "family"
      : said(text, "other", "friends", "team", "club", "work", "office") ? "other"
      : undefined;
    if (!groupType) {
      await respond('Reply "roommates", "family", or "other".');
      return true;
    }
    setups.set(key, { ...setup, step: "owner", groupType, expires });
    const who = groupType === "family" ? "Usually a parent." : "One person's card pays and everyone else pays them back.";
    await respond(`Got it, ${groupType === "other" ? "a group" : groupType}. Whose card pays for orders? ${who} Whoever it is, reply "me".`);
    return true;
  }
  if (setup.step === "owner") {
    if (!said(text, "me", "i will", "i'll", "mine", "my card")) return false; // other chat while we wait: stay quiet
    if (atSpaceLimit(msg.fromPhone)) {
      await respond(TOO_MANY_SPACES);
      return true;
    }
    setups.set(key, { ...setup, step: "name", ownerPhone: msg.fromPhone, expires });
    await respond("Thanks! What should I call you?");
    return true;
  }
  if (msg.fromPhone !== setup.ownerPhone) return false; // only the main card answers the rest
  if (setup.step === "name") {
    const name = nameFrom(text);
    if (!name) {
      await respond("What should I call you? Your first name is fine.");
      return true;
    }
    setups.set(key, { ...setup, step: "budget", name, expires });
    await respond(`Hi ${name}! Want a monthly budget for the group? Reply an amount like 200, or "no budget".`);
    return true;
  }
  // step === "budget"
  const budget = parseBudget(text);
  if (budget === undefined) {
    await respond('Reply an amount like 200, or "no budget".');
    return true;
  }
  setups.delete(key);
  const owner: Member = { id: memberId(setup.name!, allMemberIds()), name: setup.name!, phone: msg.fromPhone, role: "owner" };
  const groupType = setup.groupType ?? "other";
  newSpace("group", owner, budget, { groupChatId: msg.spaceId, groupType });
  const approvals = groupType === "family"
    ? `Only ${owner.name} approves requests.`
    : "Anyone here can approve requests by replying \"yes\".";
  await respond(
    `All set! ${owner.name}'s card pays for orders and everyone else pays ${owner.name} back. ${budgetLine(budget)} ${approvals}\n` +
      'Everyone else: text "I\'m <your name>" to join.',
  );
  await sendPrivate(
    owner.id,
    `Add the group's main card. It opens Stripe's secure page; I never see the number: ${await createCardSetupLink(owner.id)}\nLog in to manage the group: ${dashboardLink()}`,
    `setup-card:${owner.id}`,
  );
  return true;
}

/** Someone new in a set-up group: "I'm Jake" adds them. Anything else from them stays quiet. */
async function join(msg: InboundMessage, household: Household, respond: Ctx["respond"]): Promise<boolean> {
  if (!/^(?:hi[,!]?\s+)?(?:i'?m|i am|this is|call me|my name is)\s+/i.test(msg.text.trim())) return false;
  const name = nameFrom(msg.text);
  if (!name) return false;
  if (household.members.length >= 9) {
    await respond("This group is full (9 people).");
    return true;
  }
  if (atSpaceLimit(msg.fromPhone)) {
    await respond(TOO_MANY_SPACES);
    return true;
  }
  if (household.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    await respond(`There's already a ${name} here. Try "I'm ${name} B".`);
    return true;
  }
  const member: Member = {
    id: memberId(name, allMemberIds()),
    name,
    phone: msg.fromPhone,
    role: "member",
    ...(household.groupType === "family" ? {} : { canApprove: true }),
  };
  household.members.push(member);
  setActiveHousehold(member.phone, household.id);
  await respond(`Welcome, ${name}! I'll text you a link to add your card, so your share is paid automatically.`);
  await sendPrivate(
    member.id,
    `Add a card so your share is paid automatically: ${await createCardSetupLink(member.id)}\nLog in to see the group: ${dashboardLink()}`,
    `join-card:${member.id}`,
  );
  return true;
}

/** Test helper. */
export function resetOnboarding(): void {
  setups.clear();
}
