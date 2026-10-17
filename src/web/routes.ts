// Owner: Person 4 (pages) + Person 3 (redirect targets).
import { Router } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

export const webRoutes = Router();

// Short links texted to members. TODO(P3): look up the token and redirect to the Stripe Checkout URL.
webRoutes.get("/c/:token", (_req, res) => {
  res.status(501).send("Add-card link not wired yet");
});
webRoutes.get("/p/:token", (_req, res) => {
  res.status(501).send("Pay-back link not wired yet");
});

// Landing pages after Stripe Checkout. TODO(P4): branding and polish.
webRoutes.get("/card/success", (_req, res) => res.sendFile(path.join(publicDir, "card-success.html")));
webRoutes.get("/pay/success", (_req, res) => res.sendFile(path.join(publicDir, "pay-success.html")));
webRoutes.get("/cancel", (_req, res) => res.sendFile(path.join(publicDir, "cancel.html")));
