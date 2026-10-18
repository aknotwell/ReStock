// Login codes with real Photon behavior: shared lines can't text first, so the website can only text a code
// to someone who has texted Restock one-on-one. Anyone can text "code" and get one as a reply.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { spaceId: string; text: string }[]);
vi.mock("../src/config.js", async (orig) => {
  const real = (await orig<{ config: object }>()).config;
  return { config: { ...real, photonApiKey: "pho_sk_test", photonProjectId: "pho_prj_test" } };
});
vi.mock("@photon-ai/api", async (orig) => ({
  ...(await orig<object>()),
  Photon: class {
    projects = {
      sendMessage: vi.fn(async (input: { body: { spaceId: string; content: { text: string } } }) => {
        sent.push({ spaceId: input.body.spaceId, text: input.body.content.text });
        return {};
      }),
      platforms: { imessage: { assignments: {} } },
    };
  },
}));

import { createHousehold } from "../src/core/households.js";
import { resetStore } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound, resetMuted, resetPendingPrivate } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";
import { resetPayBack, sessionMember, startLogin, verifyLogin } from "../src/payments/payback.js";

const ALEX = "+14255550101";
let n = 0;

async function text(from: string, body: string, kind: "direct" | "group" = "direct") {
  const msg = { messageId: `lc${++n}`, spaceId: kind === "direct" ? `dm_${from}` : "grp_1", spaceKind: kind, fromPhone: from, text: body, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}
const codeIn = (s: string) => /code is (\d{6})/.exec(s)?.[1];

beforeEach(() => {
  resetStore();
  resetPayBack();
  resetMuted();
  resetPendingPrivate();
  resetConfirmations();
  sent.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  createHousehold("Alex", ALEX);
});

describe("login codes", () => {
  it("are not held or announced in the group for someone Restock can't text yet", async () => {
    await startLogin(ALEX);
    expect(sent).toEqual([]);
  });

  it("texting 'code' replies with a code that logs in", async () => {
    await text(ALEX, "code");
    const code = codeIn(sent.at(-1)!.text);
    expect(sent.at(-1)!.spaceId).toBe(`dm_${ALEX}`);
    expect(code).toBeDefined();
    const token = verifyLogin(ALEX, code!);
    expect(sessionMember(token)?.phone).toBe(ALEX);
  });

  it("other phrasings work too", async () => {
    for (const ask of ["login code", "send me a code", "Log in", "verification code?"]) {
      sent.length = 0;
      await text(ALEX, ask);
      expect(codeIn(sent.at(-1)?.text ?? ""), ask).toBeDefined();
    }
  });

  it("never posts a code in a group chat", async () => {
    await text(ALEX, "hi", "group");
    sent.length = 0;
    await text(ALEX, "code", "group");
    expect(sent.some((s) => codeIn(s.text))).toBe(false);
  });

  it("once they've texted one-on-one, the website's 'Text me a code' reaches them", async () => {
    await text(ALEX, "hi");
    sent.length = 0;
    await startLogin(ALEX);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.spaceId).toBe(`dm_${ALEX}`);
    expect(codeIn(sent[0]!.text)).toBeDefined();
  });

  it("someone who texted STOP gets nothing from the website", async () => {
    await text(ALEX, "hi");
    await text(ALEX, "stop");
    sent.length = 0;
    await startLogin(ALEX);
    expect(sent).toEqual([]);
  });
});
