// Owner: Person 1. Short links to store listings ("restock.select/l/ab12cd34"), so options can show where to
// look without pasting long Google URLs into the chat. Only links productLink rebuilt are ever stored, so a
// short link can only lead to a Google Shopping product page. They expire after a week.
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";
import { productLink } from "./live.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
type Entry = { url: string; expires: number };

const byToken = new Map<string, Entry>();
const byUrl = new Map<string, string>();

registerState("listing-links", {
  dump: () => [...byToken],
  load: (data) => {
    byToken.clear();
    byUrl.clear();
    for (const [token, entry] of data as [string, Entry][]) {
      if (entry.expires > Date.now()) {
        byToken.set(token, entry);
        byUrl.set(entry.url, token);
      }
    }
  },
});

/** A short Restock link for a listing page, reusing the token if this page already has one. */
export function shortLink(url: string, now = Date.now()): string | undefined {
  if (productLink(url) !== url) return undefined; // only pages productLink built
  let token = byUrl.get(url);
  const entry = token ? byToken.get(token) : undefined;
  if (!token || !entry || entry.expires <= now) {
    token = randomBytes(6).toString("base64url");
    byToken.set(token, { url, expires: now + TTL_MS });
    byUrl.set(url, token);
  } else {
    entry.expires = now + TTL_MS;
  }
  return `${config.publicBaseUrl.replace(/\/$/, "")}/l/${token}`;
}

/** Where a short link goes, or undefined if it's unknown or expired. */
export function resolveShortLink(token: string, now = Date.now()): string | undefined {
  const entry = byToken.get(token);
  return entry && entry.expires > now ? entry.url : undefined;
}

/** Tests only. */
export function clearShortLinks(): void {
  byToken.clear();
  byUrl.clear();
}
