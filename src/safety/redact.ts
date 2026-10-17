// Owner: Person 1. Output filter: every outbound text passes through here before it leaves the service (V-002).
// Defense in depth: even if something upstream leaks, personal data and secrets never reach a chat or a log.

// Secrets: Anthropic, Stripe, Photon, webhook secrets, bearer tokens. Applied everywhere, including inside URLs.
const SECRET_RULES: [RegExp, string][] = [
  [/\b(?:sk-ant-[\w-]{8,}|sk_(?:test|live)_\w{8,}|rk_(?:test|live)_\w{8,}|whsec_\w{8,}|pho_(?:sk|ask)_\w{8,})\b/g, "[redacted secret]"],
  [/\bBearer\s+[\w.-]{16,}/gi, "Bearer [redacted secret]"],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, "[redacted secret]"],
  [/\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted secret]"],
];

// Personal data and internal IDs. Not applied inside our own links: pay-back and add-card URLs carry
// random IDs (UUIDs, tokens) that would otherwise be mangled into broken links.
const PII_RULES: [RegExp, string][] = [
  [/\b(?:cus|pm|pi|seti|acct)_[A-Za-z0-9_]+\b/g, "[redacted ID]"],
  [/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[redacted ID]"],
  // Emails
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[redacted email]"],
  // SSNs
  [/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[redacted ID]"],
  // Card numbers (13–19 digits, optionally grouped)
  [/\b\d(?:[ -]?\d){12,18}\b/g, "[redacted card]"],
  // Phone numbers: +country or 10+ digits with common separators
  [/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[redacted phone]"],
];

const URL = /https?:\/\/[^\s<>"']+/g;
const apply = (rules: [RegExp, string][], t: string) => rules.reduce((acc, [re, sub]) => acc.replace(re, sub), t);

export function redact(text: string): string {
  const clean = apply(SECRET_RULES, normalizeSafetyText(text));
  // Redact PII in the text between URLs, keeping each URL intact.
  let out = "";
  let last = 0;
  for (const m of clean.matchAll(URL)) {
    out += apply(PII_RULES, clean.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + apply(PII_RULES, clean.slice(last));
}

export function normalizeSafetyText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Cf}]/gu, "").replace(/[‘’]/g, "'");
}
