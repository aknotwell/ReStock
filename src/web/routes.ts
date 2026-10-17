// Owner: Person 4 (pages) + Person 3 (redirect targets).
import { Router } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fmt } from "../messaging/templates.js";
import { openCardSetupLink, openPayBackLink } from "../payments/links.js";

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
// Pay-back links. Each tap for the same debt reuses one Stripe Checkout page, so it can't be paid twice.
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

// Landing pages after Stripe Checkout. TODO(P4): branding and polish.
webRoutes.get("/card/success", (_req, res) => res.sendFile(path.join(publicDir, "card-success.html")));
webRoutes.get("/pay/success", (_req, res) => res.sendFile(path.join(publicDir, "pay-success.html")));
webRoutes.get("/cancel", (_req, res) => res.sendFile(path.join(publicDir, "cancel.html")));
