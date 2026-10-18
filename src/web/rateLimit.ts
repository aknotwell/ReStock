// Tiny in-memory rate limiter for public endpoints (sign-up, the audit endpoint).
// Per server process; good enough for one Railway instance.
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear(); // bound memory if something floods us
    return true;
  };
}
