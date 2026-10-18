// Runs on EVERY inbound message before the LLM or the database sees it.

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

// Characters people put between card digit groups: any whitespace (incl. tabs/newlines),
// dots, slashes, underscores, and ASCII/Unicode dashes. Up to 3 in a row between digits.
const SEPARATOR = "[\\s./_\\-\\u2010-\\u2015\\u2212]{0,3}";
const CANDIDATE = new RegExp(`\\d(?:${SEPARATOR}\\d){12,}`, "g");

/** True if the text contains something that looks like a payment card number. */
export function containsCardNumber(text: string): boolean {
  const candidates = text.match(CANDIDATE) ?? [];
  return candidates.some((c) => {
    // People write cards as digit groups ("4242 4242 4242 4242 12/29 123"). Try every run of
    // whole consecutive groups, so a card followed by its expiry or CVC is still caught.
    const groups = c.split(/\D+/);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length && digits.length < 19; j++) {
        digits += groups[j];
        if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
      }
    }
    return false;
  });
}
