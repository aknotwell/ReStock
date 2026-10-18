// Owner: Person 4 (pages) + Person 3 (redirect targets).
import { Router, type Request } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import { fmt } from "../messaging/templates.js";
import { createCardSetupLink, openCardSetupLink, openPayBackLink } from "../payments/links.js";
import { householdView, ownRecord, spacesView } from "./appState.js";
import { rateLimiter } from "./rateLimit.js";
import { householdForInvite, inviteCodeFor, resetInvite, SignupError, startSignup, INVITE_TTL_MS } from "../core/signups.js";
import { findMember } from "../core/store.js";
import { LineUnavailableError } from "../messaging/photonLines.js";
import { createPayBackCheckout, logout, myDebts, SESSION_TTL_MS, sessionMember, startLogin, verifyLogin } from "../payments/payback.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

export const webRoutes = Router();

// Short links texted to members. Each tap creates a fresh Stripe Checkout session and redirects to it.
webRoutes.get("/c/:token", async (req, res) => {
  try {
    const checkoutUrl = await openCardSetupLink(req.params.token);
    if (!checkoutUrl) {
      res.status(404).send("This add-card link has expired. Ask Restock in your group chat for a new one.");
      return;
    }
    res.redirect(303, checkoutUrl);
  } catch (err) {
    console.error("add-card link failed:", err instanceof Error ? err.message : err);
    res.status(502).send("We couldn't reach our payment provider. Please try the link again in a minute.");
  }
});
// The member portal lists debts after login; individual texted links still open the specific debt.
webRoutes.get("/p/:token", async (req, res) => {
  try {
    const page = await openPayBackLink(req.params.token);
    if (page.kind === "checkout") res.redirect(303, page.url);
    else if (page.kind === "paid") res.redirect(303, "/pay/success");
    else if (page.kind === "too_small") {
      res.send(`This is ${fmt(page.cents)}, which is under the $0.50 card minimum. Please settle it with ${page.creditorName} directly.`);
    } else res.status(404).send("This pay-back link has expired. Ask Restock in your group chat for a new one.");
  } catch (err) {
    console.error("pay-back link failed:", err instanceof Error ? err.message : err);
    res.status(502).send("We couldn't reach our payment provider. Please try the link again in a minute.");
  }
});

// Pay-back site: log in with a texted code, see what you owe, pay on Stripe's page.
const PAY_COOKIE = "restock_pay";
const payToken = (req: Request) =>
  (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === PAY_COOKIE)?.[1];
const cookie = (value: string, maxAgeSeconds: number) =>
  `${PAY_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.publicBaseUrl.startsWith("https://") ? "; Secure" : ""}`;
const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");

webRoutes.get("/pay", (_req, res) => res.sendFile(path.join(publicDir, "pay.html")));
webRoutes.post("/pay/api/start", async (req, res) => {
  try {
    await startLogin(text(req.body?.handle, 80));
  } catch (err) {
    console.error("pay-back login text failed:", err instanceof Error ? err.message : err);
  }
  res.json({ ok: true }); // the same answer whether or not the number belongs to anyone
});
webRoutes.post("/pay/api/verify", (req, res) => {
  const token = verifyLogin(text(req.body?.handle, 80), text(req.body?.code, 12));
  if (!token) {
    res.status(401).json({ error: "That code didn't work. Check the text from Restock, or send a new code." });
    return;
  }
  res.setHeader("Set-Cookie", cookie(token, SESSION_TTL_MS / 1000));
  res.json({ ok: true });
});
webRoutes.get("/pay/api/me", (req, res) => {
  const member = sessionMember(payToken(req));
  if (!member) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  res.json({ name: member.name, cardLast4: member.cardLast4 ?? null, debts: myDebts(member) });
});
webRoutes.post("/pay/api/checkout", async (req, res) => {
  const member = sessionMember(payToken(req));
  if (!member) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  try {
    res.json({ url: await createPayBackCheckout(member, text(req.body?.debtId, 80), req.body?.saveCard === true) });
  } catch (err) {
    console.error("pay-back checkout failed:", err instanceof Error ? err.message : err);
    res.status(400).json({ error: "We couldn't open the payment page. Refresh and try again." });
  }
});
webRoutes.post("/pay/api/logout", (req, res) => {
  logout(payToken(req));
  res.setHeader("Set-Cookie", cookie("", 0));
  res.json({ ok: true });
});

// Dashboard data: the logged-in member's own household only, read-only. Same texted-code login as /pay.
webRoutes.get("/app/api/state", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const member = sessionMember(payToken(req));
  const state = member && householdView(member);
  if (!state) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  res.json(state);
});
// All of the person's spaces (personal and group) for the dashboard's Personal and Groups pages.
webRoutes.get("/app/api/spaces", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const member = sessionMember(payToken(req));
  if (!member) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  res.json({ spaces: spacesView(member) });
});
// "Set up card" on the dashboard: the same Stripe add-card link "add card" texts. Only for your own records.
webRoutes.post("/app/api/card-link", async (req, res) => {
  const member = sessionMember(payToken(req));
  const target = member && ownRecord(member, text(req.body?.memberId, 80) || member.id);
  if (!target) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  try {
    res.json({ url: await createCardSetupLink(target.id) });
  } catch (err) {
    console.error("dashboard card link failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "We couldn't open the card page. Try again in a minute." });
  }
});

// ---------- Web sign-up and invite links ----------
// Start a household at /start, or join one at /join/<code>. Either way the person gets a Restock number to
// text, and their first text activates them (src/core/signups.ts).
const signupsPerIp = rateLimiter(10, 60 * 60 * 1000);
const signupsPerPhone = rateLimiter(5, 60 * 60 * 1000);
const signupPage = (_req: Request, res: import("express").Response) => res.sendFile(path.join(publicDir, "signup.html"));
webRoutes.get("/start", signupPage);
webRoutes.get("/join/:code", signupPage);
webRoutes.get("/privacy", (_req, res) => res.sendFile(path.join(publicDir, "privacy.html")));

webRoutes.get("/signup/api/invite/:code", (req, res) => {
  const household = householdForInvite(text(req.params.code, 64));
  if (!household) {
    res.status(404).json({ error: "This invite link has expired or was reset. Ask for a new one." });
    return;
  }
  const owner = household.members.find((m) => m.id === household.ownerId);
  res.json({ householdName: `${owner?.name ?? "A"}'s household`, members: household.members.length });
});

webRoutes.post("/signup/api/start", async (req, res) => {
  const phoneKey = text(req.body?.phone, 40).replace(/\D/g, "");
  if (!signupsPerIp(req.ip ?? "unknown") || !signupsPerPhone(phoneKey || "none")) {
    res.status(429).json({ error: "Too many sign-up attempts. Please wait a bit and try again." });
    return;
  }
  if (req.body?.consent !== true) {
    res.status(400).json({ error: "Please agree to the terms and to getting texts from Restock." });
    return;
  }
  try {
    const result = await startSignup({
      name: text(req.body?.name, 40),
      phone: text(req.body?.phone, 40),
      inviteCode: text(req.body?.inviteCode, 64) || undefined,
    });
    res.json({ ...result, smsLink: `sms:${result.line}&body=hi` });
  } catch (err) {
    if (err instanceof SignupError || err instanceof LineUnavailableError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("sign-up failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// The owner's invite link (dashboard "Invite roommates"). Owner-only.
const ownerHousehold = (req: Request) => {
  const member = sessionMember(payToken(req));
  const found = member && findMember(member.id);
  return found && found.household.ownerId === found.member.id ? found : undefined;
};
const inviteUrl = (code: string) => `${config.publicBaseUrl}/join/${code}`;
webRoutes.post("/app/api/invite", (req, res) => {
  const found = ownerHousehold(req);
  if (!found) {
    res.status(403).json({ error: "Only the budget owner can invite people." });
    return;
  }
  const reset = req.body?.reset === true;
  const code = reset ? resetInvite(found.household, found.member.id) : inviteCodeFor(found.household, found.member.id);
  res.json({ url: inviteUrl(code), expiresInDays: INVITE_TTL_MS / 86_400_000 });
});

// Landing pages after Stripe Checkout. TODO(P4): branding and polish.
webRoutes.get("/card/success", (_req, res) => res.sendFile(path.join(publicDir, "card-success.html")));
webRoutes.get("/pay/success", (_req, res) => res.sendFile(path.join(publicDir, "pay-success.html")));
webRoutes.get("/cancel", (_req, res) => res.sendFile(path.join(publicDir, "cancel.html")));
webRoutes.get("/dashboard", (_req, res) => res.sendFile(path.join(publicDir, "dashboard.html")));
webRoutes.get("/", (_req, res) => res.sendFile(path.join(publicDir, "landing.html")));
