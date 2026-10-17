// Person 1. Photon 2.0 via the documented Spectrum cloud iMessage provider.
import { z } from "zod";
import type { Message, Space } from "spectrum-ts";
import { getHousehold, findMember } from "../core/store.js";

export const InboundMessageSchema = z.object({
  id: z.string().min(1).max(200),
  groupChatId: z.string().min(1).max(300),
  fromPhone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  text: z.string().min(1).max(4000),
}).strict();
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

const spaces = new Map<string, Space>();
async function connect() {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET;
  if (!projectId || !projectSecret || !webhookSecret) throw new Error("Photon cloud credentials and webhook secret are required");
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app = await Spectrum({ projectId, projectSecret, webhookSecret, providers: [imessage.config()],
    telemetry: false, options: { logLevel: "error" } });
  return { app, im: imessage(app) };
}
let connection: ReturnType<typeof connect> | undefined;
export function photonConnection(): ReturnType<typeof connect> {
  connection ??= connect().catch((error: unknown) => { connection = undefined; throw error; });
  return connection;
}

export function normalizePhotonMessage(space: Pick<Space, "id">, message: Pick<Message, "id" | "direction" | "platform" | "sender" | "content">): InboundMessage | undefined {
  if (message.direction !== "inbound" || message.platform !== "imessage" || message.sender?.kind === "agent" || message.content.type !== "text") return;
  const parsed = InboundMessageSchema.safeParse({ id: message.id, groupChatId: space.id, fromPhone: message.sender?.id, text: message.content.text });
  return parsed.success ? parsed.data : undefined;
}

export function rememberSpace(space: Space): void { spaces.set(space.id, space); }

export async function sendGroup(householdId: string, text: string): Promise<void> {
  const h = getHousehold(householdId);
  let space = spaces.get(h.groupChatId);
  if (!space) {
    const { im } = await photonConnection();
    space = await im.space.get(h.groupChatId);
    spaces.set(h.groupChatId, space);
  }
  await space.send(text);
}

export async function sendPrivate(memberId: string, text: string): Promise<void> {
  const found = findMember(memberId);
  if (!found) throw new Error("Unknown private recipient");
  const { im } = await photonConnection();
  const user = await im.user(found.member.phone);
  const dm = await im.space.create(user);
  await dm.send(text);
}
