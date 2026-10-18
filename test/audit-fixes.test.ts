// Fixes from the repo audit: logins survive deploys (stored hashed), one place per number when texting
// one-on-one, and invited members can approve (except in a family).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, createHousehold, MembershipError } from "../src/core/households.js";
import { closeDatabase, openDatabase, saveNow } from "../src/core/persist.js";
import { db, resetStore, UNBOUND_GROUP } from "../src/core/store.js";
import { inviteCodeFor, resetSignups, startSignup, activateFromFirstText } from "../src/core/signups.js";
import { needsApproval } from "../src/core/approvals.js";
import { resetPayBack, sessionMember, startLogin, verifyLogin } from "../src/payments/payback.js";

let logs: string[];
beforeEach(() => {
  resetStore();
  resetSignups();
  resetPayBack();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => closeDatabase());

describe("login sessions survive a restart", () => {
  it("restores the session from the database, which holds only hashes", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "restock-")), "restock.db");
    openDatabase(file);
    createHousehold("Alex", "+14255550101");
    await startLogin("+14255550101");
    const code = /Your Restock code is (\d{6})/.exec(logs.join("\n"))![1]!;
    const token = verifyLogin("+14255550101", code)!;
    expect(sessionMember(token)?.name).toBe("Alex");
    saveNow();
    closeDatabase();

    resetPayBack(); // the "deploy": memory is gone
    resetStore();
    expect(sessionMember(token)).toBeUndefined();
    openDatabase(file); // the new process loads what was saved
    expect(sessionMember(token)?.name).toBe("Alex");

    const raw = readFileSync(file).toString("latin1");
    expect(raw).not.toContain(token);
  });

  it("a saved login code is a hash, not the code", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "restock-")), "restock.db");
    openDatabase(file);
    createHousehold("Alex", "+14255550101");
    await startLogin("+14255550101");
    const code = /Your Restock code is (\d{6})/.exec(logs.join("\n"))![1]!;
    saveNow();
    expect(readFileSync(file).toString("latin1")).not.toContain(`"code":"${code}"`);
    expect(verifyLogin("+14255550101", code)).toBeDefined(); // still verifies against the hash
  });
});

describe("one place per number when texting one-on-one", () => {
  const personal = (phone: string) => {
    db.households.set("p1", { id: "p1", kind: "personal", groupChatId: `personal:${phone}`, ownerId: "zoe", spentCents: 0, members: [{ id: "zoe", name: "Zoe", phone, role: "owner" }] });
  };

  it("someone with a personal space can't be added to a household without a group chat", () => {
    personal("+12065550190");
    const h = createHousehold("Alex", "+14255550101");
    expect(h.groupChatId).toBe(UNBOUND_GROUP);
    expect(() => addMember(h, "Zoe", "+12065550190")).toThrow(/personal Restock space.*delete my data/);
  });

  it("but can join a household that has a real group chat (their group texts reach it)", () => {
    personal("+12065550190");
    const h = createHousehold("Alex", "+14255550101");
    h.groupChatId = "pho_spc_group";
    expect(addMember(h, "Zoe", "+12065550190").name).toBe("Zoe");
  });

  it("someone with a personal space can't start a second space", () => {
    personal("+12065550190");
    expect(() => createHousehold("Zoe", "+12065550190")).toThrow(MembershipError);
  });

  it("web sign-up explains the one-place rule", async () => {
    personal("+12065550190");
    await expect(startSignup({ name: "Zoe", phone: "+12065550190" })).rejects.toThrow(/already uses Restock.*delete my data/);
  });
});

describe("approval rights for people who join", () => {
  it("invited roommates can approve, so their items don't wait for the owner", async () => {
    const h = createHousehold("Alex", "+14255550101");
    await startSignup({ name: "Amber", phone: "+14255550102", inviteCode: inviteCodeFor(h, h.ownerId) });
    const amber = activateFromFirstText("+14255550102")!.member;
    expect(amber.canApprove).toBe(true);
    expect(needsApproval(h, amber, 799)).toBe(false);
  });

  it("in a family, only the owner approves", () => {
    const h = createHousehold("Mom", "+14255550111");
    h.groupType = "family";
    const kid = addMember(h, "Maya", "+14255550112");
    expect(kid.canApprove).toBeUndefined();
    expect(needsApproval(h, kid, 500)).toBe(true);
  });
});
