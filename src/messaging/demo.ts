// Local-only conversation harness. It never sends messages or calls Stripe.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { seedDemo } from "../../scripts/seed.js";
import { db } from "../core/store.js";
import { OrderError } from "../core/orders.js";
import { createMessageParser, parseMessage } from "../ai/parseMessage.js";
import { createAgent } from "./inbound.js";

const household = seedDemo();
db.items.clear();
let sequence = 0;
const agent = createAgent({
  parse: process.argv.includes("--ai") ? parseMessage : createMessageParser(),
  group: async (_id, text) => { console.log(`\nRestock → group: ${text}`); },
  private: async (id, text) => { console.log(`\nRestock → ${id} privately: ${text}`); },
  card: async () => "https://example.test/demo-card-setup",
  pay: async () => "https://example.test/demo-payback",
  order: async () => { throw new OrderError("Checkout handoff reached. This local harness never charges cards. Person 2’s split engine and Person 3’s Stripe implementation must be connected for test checkout."); },
});
async function send(line: string) {
  const match = /^(sam|jake|priya):\s*(.*)$/i.exec(line);
  const member = household.members.find((m) => m.id === (match?.[1]?.toLowerCase() ?? "priya"))!;
  await agent({ id: `demo-${++sequence}`, groupChatId: household.groupChatId, fromPhone: member.phone, text: match?.[2] ?? line });
}
console.log("Restock local demo. No real messages, charges or purchases. Prefix a message with sam:, jake:, or priya: (default Priya). Type exit to finish.");
if (process.argv.includes("--script")) {
  for (const line of ["priya: we're out of TP", "jake: add soap", "jake: yes", "priya: add paper towels", "jake: add air fryer", "sam: yes", "jake: add chips", "sam: add oat milk", "sam: order now"]) {
    console.log(`\n> ${line}`); await send(line);
  }
} else {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = await terminal.question("\nYou: ");
      if (line.trim().toLowerCase() === "exit") break;
      if (line.trim()) await send(line);
    }
  } finally { terminal.close(); }
}
