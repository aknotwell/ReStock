// Owner: Person 1. Output filter: every outbound text passes through here before it leaves the service (V-002).
// Defense in depth: even if something upstream leaks, personal data and secrets never reach a chat or a log.

const RULES: [RegExp, string][] = [
  // Secrets: Anthropic, Stripe, Photon, webhook secrets, bearer tokens
  [/\b(?:sk-ant-[\w-]{8,}|sk_(?:test|live)_\w{8,}|rk_(?:test|live)_\w{8,}|whsec_\w{8,}|pho_(?:sk|ask)_\w{8,})\b/g, "[redacted secret]"],
  [/\bBearer\s+[\w.-]{16,}/gi, "Bearer [redacted secret]"],
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
  return RULES.reduce((t, [re, sub]) => t.replace(re, sub), text);
}
