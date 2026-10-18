// Live-test failures from Oct 17: one person who hadn't DM'd the agent (or a group chat the agent
// couldn't reach) stopped everyone else's receipts and pay-back links. Photon is faked here.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => {
  const real = (await importOriginal()) as { config: Record<string, unknown> };
  return { config: { ...real.config, photonApiKey: "pho_sk_fake", photonProjectId: "pho_prj_fake" } };
});
const sent: { spaceId: string; text: string }[] = [];
const failSpaces = new Set<string>();
vi.mock("@photon-ai/api", () => ({
  ApiError: class extends Error {},
  Photon: class {
    projects = {
      sendMessage: vi.fn(async ({ body }: { body: { spaceId: string; content: { text: string } } }) => {
        if (failSpaces.has(body.spaceId)) throw new Error("photon unavailable");
        sent.push({ spaceId: body.spaceId, text: body.content.text });
      }),
      listMessages: vi.fn(),
    };
  },
}));
const fakeStripe = {
  paymentIntents: {
    create: vi.fn(async (p: { amount: number; metadata: { memberId: string } }) => ({ id: `pi_${p.metadata.memberId}`, status: "requires_capture" })),
    capture: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
  },
  refunds: { create: vi.fn() },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { seedDemo } = await import("../scripts/seed.js");
const { handleInbound, waitingForDm } = await import("../src/messaging/inbound.js");
const { deliverPending, rememberInbound, resetPendingPrivate } = await import("../src/messaging/photon.js");

const SAM = "+15550000001", JAKE = "+15550000002", PRIYA = "+15550000003";
const dm = (phone: string) => `pho_spc_dm_${phone}`;
let n = 0;

/** What the poller does for each received text. */
async function text(from: string, body: string, space = dm(from)) {
  const msg = { messageId: `h${++n}`, spaceId: space, spaceKind: space.startsWith("pho_spc_dm") ? ("direct" as const) : ("group" as const), fromPhone: from, text: body, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await deliverPending(msg);
  await handleInbound(msg);
}
const textsIn = (space: string) => sent.filter((s) => s.spaceId === space).map((s) => s.text).join("\n");

beforeEach(() => {
  sent.length = 0;
  failSpaces.clear();
  resetPendingPrivate();
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("private texts for people who haven't DM'd the agent yet", () => {
  it("order now still works, tells the sender who's missing, and holds their texts", async () => {
    await text(SAM, "order now"); // only Sam has ever texted the agent; there's no group chat

    const samDm = textsIn(dm(SAM));
    expect(samDm).toMatch(/Ordered! 6 items, \$72\.75/);
    expect(samDm).toMatch(/Receipt: your share is \$15\.65/);
    expect(samDm).toMatch(/Jake and Priya haven't texted me directly yet\. I'll send their private messages as soon as they do\./);
    expect(textsIn(dm(PRIYA))).toBe(""); // nothing sent anywhere for Priya yet
  });

  it("delivers the held pay-back link the moment that person texts the agent", async () => {
    await text(SAM, "order now");
    await text(PRIYA, "help");

    const priyaDm = textsIn(dm(PRIYA));
    expect(priyaDm).toMatch(/Your share of this week's order is \$10\.15\. Sam's card covered it\./);
    expect(priyaDm).toMatch(/Pay Sam back: https?:\/\/\S+\/p\/[A-Za-z0-9]{22}/);
    // Delivered once: a second DM doesn't resend it.
    const before = sent.length;
    await text(PRIYA, "thanks");
    expect(sent.slice(before).some((s) => /Pay Sam back/.test(s.text))).toBe(false);
  });

  it("delivers Jake's held receipt too, and each person only gets their own", async () => {
    await text(SAM, "order now");
    await text(JAKE, "hi");
    const jakeDm = textsIn(dm(JAKE));
    expect(jakeDm).toMatch(/Receipt: your share is \$46\.95/);
    expect(jakeDm).not.toMatch(/Pay Sam back/);
  });
});

describe("when the group chat or one person can't be reached", () => {
  it("posts the order summary in the sender's chat if the group chat isn't reachable", async () => {
    const h = seedDemo();
    h.groupChatId = "pho_spc_group_from_before_a_restart"; // bound, but no agent identity known for it
    for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;

    await text(SAM, "order now");
    expect(textsIn(dm(SAM))).toMatch(/Ordered! 6 items/);
  });

  it("one person's send failing doesn't stop the texts to everyone after them", async () => {
    await text(JAKE, "hi");
    await text(PRIYA, "hi");
    failSpaces.add(dm(JAKE)); // Jake comes before Priya in the household
    sent.length = 0;

    await text(SAM, "order now");
    expect(textsIn(dm(PRIYA))).toMatch(/Pay Sam back:/);
    expect(textsIn(dm(SAM))).toMatch(/Receipt: your share is \$15\.65/);
  });
});

describe("waitingForDm", () => {
  it("reads naturally for one, two, or more names", () => {
    expect(waitingForDm(["Abdul"])).toMatch(/^Abdul hasn't texted me directly yet\./);
    expect(waitingForDm(["Abdul", "David"])).toMatch(/^Abdul and David haven't/);
    expect(waitingForDm(["Alex", "Abdul", "David"])).toMatch(/^Alex, Abdul and David haven't/);
  });
});
