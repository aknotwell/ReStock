// Fixes from the repo audit: logins survive deploys (stored hashed), one number in several households,
// and invited members can approve (except in a family).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeHousehold, addMember, createHousehold, MAX_SPACES_PER_PHONE, MembershipError } from "../src/core/households.js";
import { closeDatabase, openDatabase, saveNow } from "../src/core/persist.js";
import { db, householdsForPhone, resetStore, UNBOUND_GROUP } from "../src/core/store.js";
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

describe("one number in several households", () => {
  const personal = (phone: string) => {
    db.households.set("p1", { id: "p1", kind: "personal", groupChatId: `personal:${phone}`, ownerId: "zoe", spentCents: 0, members: [{ id: "zoe", name: "Zoe", phone, role: "owner" }] });
  };

  it("someone with a personal space can also join a household without a group chat", () => {
    personal("+12065550190");
    const h = createHousehold("Alex", "+14255550101");
    expect(h.groupChatId).toBe(UNBOUND_GROUP);
    expect(addMember(h, "Zoe", "+12065550190").name).toBe("Zoe");
    expect(activeHousehold("+12065550190")?.id).toBe(h.id); // joining makes it where her texts go
  });

  it("and can start a household of their own", () => {
    personal("+12065550190");
    const h = createHousehold("Zoe", "+12065550190", { name: "Soccer Team" });
    expect(householdsForPhone("+12065550190").map((x) => x.id)).toEqual(["p1", h.id]);
  });

  it("stops at the per-number limit, on the web too", async () => {
    for (let i = 0; i < MAX_SPACES_PER_PHONE; i++) createHousehold("Zoe", "+12065550190", { name: `Group ${i + 1}` });
    expect(() => createHousehold("Zoe", "+12065550190")).toThrow(MembershipError);
    await expect(startSignup({ name: "Zoe", phone: "+12065550190" })).rejects.toThrow(/already in 5 Restock households/);
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
