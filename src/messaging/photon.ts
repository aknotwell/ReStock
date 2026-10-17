// Owner: Person 1. Photon 2.0 transport (photon.co/beta).
// TODO(P1): replace the console stubs with the Photon 2.0 SDK/API once the beta account is set up.
// Track docs: https://somethingreat.notion.site/Hackathon-Guidelines-for-Photon-2-0-3f8e443f36bb81f9893fed0d08a4c01d
import { getHousehold, findMember } from "../core/store.js";

export async function sendGroup(householdId: string, text: string): Promise<void> {
  const h = getHousehold(householdId);
  console.log(`[photon → group ${h.groupChatId}]\n${text}\n`);
}

export async function sendPrivate(memberId: string, text: string): Promise<void> {
  const found = findMember(memberId);
  console.log(`[photon → ${found?.member.name ?? memberId} (private)]\n${text}\n`);
}

/** Normalized inbound message. TODO(P1): map Photon's webhook payload to this shape. */
export type InboundMessage = {
  groupChatId: string;
  fromPhone: string;
  text: string;
};
