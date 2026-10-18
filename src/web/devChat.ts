// Owner: Person 4. Test chat for the dashboard: text as a demo member and see every reply, private ones included,
// through the real inbound pipeline. Nothing is sent to a phone. Mounted only when DEV_INBOUND=1 (it is unauthenticated).
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { attachDemoCards } from "../../scripts/demoCards.js";
import { DEMO_HOUSEHOLD_ID, seedDemo } from "../../scripts/seed.js";
import { computeShares } from "../core/split.js";
import { db, pendingItems, UNBOUND_GROUP } from "../core/store.js";
import { handleInbound } from "../messaging/inbound.js";
import { captureOutboundDetailed } from "../messaging/photon.js";

export const devChat = Router();

const DEV_GROUP = "dev-group";
const dmSpace = (memberId: string) => `dev-dm:${memberId}`;

/** What the dashboard shows next to the chat: members, the pending cart, and the smart split if ordered now. */
function chatState() {
  const h = db.households.get(DEMO_HOUSEHOLD_ID);
  if (!h) return undefined;
  const items = pendingItems(h.id);
  return {
    budgetCents: h.budgetCents,
    spentCents: h.spentCents,
    members: h.members.map((m) => ({ id: m.id, name: m.name, role: m.role, hasCard: !!m.paymentMethodId })),
    items: items.map((i) => ({ id: i.id, name: i.name, addedBy: i.addedBy, cents: i.cents, shared: i.shared, needsApproval: !!i.needsApproval })),
    shares: computeShares(items.filter((i) => !i.needsApproval), h.members, "smart"),
    debts: [...db.debts.values()].filter((d) => d.status === "open" && h.members.some((m) => m.id === d.debtorId)),
  };
}

const NO_HOUSEHOLD = "No demo household yet. Press Reset demo, or start the server with DEMO_SEED=1.";

devChat.get("/dev/state", (_req, res) => {
  const state = chatState();
  if (!state) res.status(404).json({ error: NO_HOUSEHOLD });
  else res.json(state);
});

devChat.post("/dev/chat", async (req, res) => {
  const { memberId, text, direct } = (req.body ?? {}) as { memberId?: unknown; text?: unknown; direct?: unknown };
  const household = db.households.get(DEMO_HOUSEHOLD_ID);
  const member = household?.members.find((m) => m.id === memberId);
  if (!household || !member) {
    res.status(404).json({ error: household ? "Pick a member of the demo household." : NO_HOUSEHOLD });
    return;
  }
  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    res.status(400).json({ error: "Send a message of 1 to 4000 characters." });
    return;
  }

  const spaceId = direct === true ? dmSpace(member.id) : household.groupChatId === UNBOUND_GROUP ? DEV_GROUP : household.groupChatId;
  let error: string | undefined;
  const captured = await captureOutboundDetailed(async () => {
    try {
      await handleInbound({ messageId: randomUUID(), spaceId, spaceKind: direct === true ? "direct" : "group", fromPhone: member.phone, text });
    } catch (err) {
      // Usually a missing STRIPE_SECRET_KEY on "order now". Show it in the chat instead of failing the request.
      error = err instanceof Error ? err.message : String(err);
    }
  });

  const replies = captured.map((c) => ({
    to: c.memberId ?? (c.spaceId === dmSpace(member.id) ? member.id : "group"),
    text: c.text,
  }));
  res.json({ replies, error, state: chatState() });
});

devChat.post("/dev/reset", async (_req, res) => {
  const household = seedDemo();
  await attachDemoCards(household); // real sandbox cards when a Stripe test key is set, same as server start
  res.json(chatState());
});
