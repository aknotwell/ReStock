// Owner: Person 1 (drafted by Person 3). Everyday ways of asking for something, understood without
// the AI: "we're out of TP", "we need dish soap", "can we get oat milk?", "the coffee is almost gone".
// Only counts when what's asked for is a real catalog item, so chat like "I need a nap" or "we're out
// of ideas" never gets an "I couldn't find that" reply in the group.
import { catalog } from "../core/catalog.js";

// "<lead-in> <items>": the lead-in says someone needs something, the rest names it.
const LEAD_INS: RegExp[] = [
  /^(?:we(?:'re| are)?|were|i(?:'m| am)?|im|we've|weve|i've|ive|we have|i have|you guys are|y'?all are)?\s*(?:all\s+|totally\s+|completely\s+)?(?:out of|ran out of|run out of|running out of|running low on|low on|almost out of|nearly out of|basically out of)\s+(.+)$/,
  /^(?:we|i|you guys)\s+(?:need|want|could use|gotta get|should get|have to get|need to get|need to buy|should buy)\s+(.+)$/,
  /^(?:can|could|would|will)\s+(?:we|you|someone|somebody|anyone|u)\s+(?:please\s+)?(?:get|grab|buy|order|pick up|add|restock)\s+(.+)$/,
  /^(?:please\s+)?(?:need|get|grab|buy|order|pick up|restock|reorder)\s+(.+)$/,
  /^(?:no|zero)\s+more\s+(.+?)(?:\s+left)?$/,
];
// "<items> is out", "the coffee is almost gone"
const TRAILING = /^(.+?)\s+(?:is|are|'s)\s+(?:out|gone|empty|finished|running low|almost gone|almost out|nearly gone|all gone|used up)$/;
// "tp please", "more coffee pls": a bare item name counts when it ends politely.
const POLITE = /\b(?:please|pls|plz)\W*$/i;

// Who it's for stays on the text so splitWith.ts can read it ("we need oat milk for me and Jake").
const SPLIT_PHRASE = /\s+(?:for|split (?:it )?(?:with|between)|shared? (?:it )?(?:with|between)|between)\s+.+$/;
const FILLER = /\s+(?:again|lol|lmao|haha|rn|asap|today|tonight|soon|already|now|too|guys|y'?all|ugh|fyi|please|pls|plz|thanks|thx|ty)$/;
const LEADING = /^(?:the|some|more|a|an|our|any|new|another)\s+/;
const EMOJI = /\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u;

function clean(text: string): string {
  let t = stripIntensifiers(text.trim().toLowerCase().replace(/[’]/g, "'")).replace(/[!?.…]+$/, "").replace(EMOJI, "").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(FILLER, "").replace(/^(?:ugh|hey|yo|ok|okay|so|btw|also|oh|um|uh),?\s+/, "").replace(/[!?.,]+$/, "").trim();
  }
  return t;
}

// Swearing and intensifiers aren't part of an item's name: "out of fucking dish soap" is dish soap.
const INTENSIFIERS = /\b(?:fucking|fuckin|fking|fkn|effing|freaking|freakin|fricking|frickin|friggin|damn|damned|goddamn|bloody)\b'?/gi;

/** The text without swearing or intensifiers, spaces tidied. */
export function stripIntensifiers(text: string): string {
  return text.replace(INTENSIFIERS, " ").replace(/\s+/g, " ").trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A catalog product named in this text: whole words only, so "need a nap" doesn't match "napkins". */
function isCatalogItem(name: string): boolean {
  const q = name.replace(LEADING, "").trim();
  if (q.length < 2) return false;
  return catalog.some((p) => p.name.toLowerCase() === q || p.aliases.some((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`).test(q)));
}

/**
 * Item names asked for in casual wording, or undefined if this isn't a casual request for catalog items.
 * Several items ("TP and dish soap") come back separately; "for me and Jake" stays on the last one.
 */
export function casualItems(text: string): string[] | undefined {
  const t = clean(text);
  let phrase: string | undefined;
  for (const re of LEAD_INS) {
    const m = re.exec(t);
    if (m?.[1]) {
      phrase = m[1];
      break;
    }
  }
  phrase ??= TRAILING.exec(t)?.[1] ?? (POLITE.test(text.trim()) ? t : undefined);
  if (!phrase) return undefined;

  const who = SPLIT_PHRASE.exec(phrase)?.[0] ?? "";
  const items = phrase.slice(0, phrase.length - who.length).replace(LEADING, "").trim();
  if (!items) return undefined;

  // "tp and dish soap" -> two items, but only when every piece is a catalog item on its own.
  const pieces = items.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((p) => p.replace(LEADING, "").trim()).filter(Boolean);
  if (pieces.length > 1 && pieces.every(isCatalogItem)) {
    return pieces.map((p, i) => (i === pieces.length - 1 ? p + who : p));
  }
  return isCatalogItem(items) ? [items + who] : undefined;
}
