// Owner: Person 1. Output filter: every outbound text passes through here before it leaves the service (V-002).
// Defense in depth: even if something upstream leaks, personal data and secrets never reach a chat or a log.

const RULES: [RegExp, string][] = [
  // Secrets: Anthropic, Stripe, Photon, webhook secrets, bearer tokens
  [/\b(?:sk-ant-[\w-]{8,}|sk_(?:test|live)_\w{8,}|rk_(?:test|live)_\w{8,}|whsec_\w{8,}|pho_(?:sk|ask)_\w{8,})\b/g, "[redacted secret]"],
  [/\bBearer\s+[\w.-]{16,}/gi, "Bearer [redacted secret]"],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, "[redacted secret]"],
  [/\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted secret]"],
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

export function redact(text: string): string {
  return RULES.reduce((t, [re, sub]) => t.replace(re, sub), normalizeSafetyText(text));
}

export function normalizeSafetyText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Cf}]/gu, "").replace(/[‘’]/g, "'");
}
