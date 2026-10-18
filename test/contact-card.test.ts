// "Save restock to your contacts": a vCard named "restock", with the logo, for Restock's own numbers only.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "../src/core/store.js";
import { startSignup } from "../src/core/signups.js";
import { contactReply, handleInbound, isContactRequest } from "../src/messaging/inbound.js";
import { CONSOLE_LINE, isRestockLine, rememberRestockLine } from "../src/messaging/photonLines.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { CONTACT_NAME, contactCard, contactLink, contactPhoto, encodePng } from "../src/web/contactCard.js";
import { webRoutes } from "../src/web/routes.js";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(webRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let logs: string[];
beforeEach(() => {
  resetStore();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** Unfold a vCard (continuation lines start with a space). */
const unfold = (card: string) => card.replace(/\r\n /g, "");

describe("the contact card", () => {
  it("is named 'restock' in lowercase, with the Restock number", () => {
    const card = unfold(contactCard("+12065550142"));
    expect(CONTACT_NAME).toBe("restock");
    expect(card).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(card).toContain("\r\nFN:restock\r\n");
    expect(card).toContain("\r\nN:;restock;;;\r\n");
    expect(card).toContain("\r\nTEL;TYPE=CELL,VOICE:+12065550142\r\n");
    expect(card).toMatch(/END:VCARD\r\n$/);
  });

  it("keeps every line within the vCard's 75-character limit", () => {
    for (const line of contactCard("+12065550142").split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
  });

  it("carries the logo as a 256x256 PNG photo", () => {
    const photo = /PHOTO;ENCODING=b;TYPE=PNG:([A-Za-z0-9+/=]+)/.exec(unfold(contactCard("+12065550142")))?.[1];
    const png = Buffer.from(photo!, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(256); // width
    expect(png.readUInt32BE(20)).toBe(256); // height
    expect(png).toEqual(contactPhoto());
  });

  it("draws brand yellow behind a dark stub", () => {
    const png = contactPhoto();
    const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
    const rows = inflateSync(idat);
    const px = (x: number, y: number) => [...rows.subarray(y * (256 * 3 + 1) + 1 + x * 3, y * (256 * 3 + 1) + 1 + x * 3 + 3)];
    expect(px(2, 2)).toEqual([0xff, 0xe8, 0x66]); // corner: background
    expect(px(128, 150)).toEqual([0x16, 0x16, 0x16]); // middle of the stub, right of the "r"
  });

  it("writes valid PNG checksums", () => {
    const png = encodePng(Buffer.from([1, 2, 3]), 1, 1);
    expect(png.subarray(-4).toString("hex")).toBe("ae426082"); // the IEND chunk's CRC is always this value
  });
});

describe("GET /contact/<number>.vcf", () => {
  it("serves the card for a Restock number", async () => {
    rememberRestockLine("+12065550142");
    const res = await fetch(contactLink("+12065550142").replace(/^https?:\/\/[^/]+/, base));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/vcard/);
    expect(res.headers.get("content-disposition")).toMatch(/filename="restock\.vcf"/);
    expect(await res.text()).toContain("FN:restock");
  });

  it("works for the console line when Photon isn't configured (local dev)", async () => {
    expect(isRestockLine(CONSOLE_LINE)).toBe(true);
    expect((await fetch(`${base}/contact/${encodeURIComponent(CONSOLE_LINE)}.vcf`)).status).toBe(200);
  });

  it.each(["+12065559999", "12065550142", "not-a-number", "+1206555014x"])("refuses anything that isn't a Restock line: %s", async (n) => {
    const res = await fetch(`${base}/contact/${encodeURIComponent(n)}.vcf`);
    expect(res.status).toBe(404);
  });
});

describe("over chat", () => {
  it.each(["contact", "save contact", "Add contact", "contact card", "vcard", "send me your contact", "get restock's contact info"])("%s is a contact request", (t) => {
    expect(isContactRequest(t)).toBe(true);
  });

  it.each(["add milk", "contact jake about rent", "add member Abdul 4255550101", "who is my contact?"])("%s is not", (t) => {
    expect(isContactRequest(t)).toBe(false);
  });

  it("answers 'contact' with a link for the number they texted", async () => {
    const { seedDemo } = await import("../scripts/seed.js");
    seedDemo();
    const msg = { messageId: "c1", spaceId: "pho_spc_dm", spaceKind: "direct" as const, fromPhone: "+15550000001", text: "contact", agentUserId: "pho_usr_agent", agentLine: "+12065550142" };
    rememberInbound(msg); // learns +12065550142 as a Restock line
    await handleInbound(msg);
    expect(logs.join("\n")).toMatch(/Tap to save me as "restock" in your contacts: \S+\/contact\/%2B12065550142\.vcf/);
  });

  it("falls back to plain advice if it doesn't know the number", () => {
    expect(contactReply(undefined)).toBe('Save this number in your contacts as "restock" so you can find me easily.');
    expect(contactReply("+19999999999")).toMatch(/Save this number in your contacts/);
  });

  it("the welcome after signing up includes the link", async () => {
    await startSignup({ name: "Alex", phone: "4255550101" });
    const hi = { messageId: "w1", spaceId: "pho_spc_dm_alex", spaceKind: "direct" as const, fromPhone: "+14255550101", text: "hi", agentUserId: "pho_usr_agent" };
    rememberInbound(hi);
    await handleInbound(hi);
    expect(logs.join("\n")).toMatch(/Welcome to Restock, Alex![\s\S]*Save me as "restock" in your contacts: \S+\/contact\/%2B16285550100\.vcf/);
  });
});
