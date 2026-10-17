// Owner: Person 1. Runs on EVERY inbound message before the LLM or the database sees it.

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True if the text contains something that looks like a payment card number. */
export function containsCardNumber(text: string): boolean {
  // Accept repeated whitespace/dashes too, so formatting cannot bypass the guard.
  const candidates = text.match(/\d(?:[\s-]*\d){12,18}/g) ?? [];
  return candidates.some((c) => {
    const digits = c.replace(/[\s-]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}
