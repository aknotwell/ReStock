// Owner: Person 2. Demo product catalog (data/catalog.json) — the dataset the AI matches against.
import { readFileSync } from "node:fs";
import type { Cents } from "../types.js";

export type Product = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  cents: Cents;
  defaultShared: boolean;
  restockDays: number | null;
};

const raw = JSON.parse(readFileSync(new URL("../../data/catalog.json", import.meta.url), "utf8")) as { products: Product[] };

export const catalog: readonly Product[] = raw.products;

export function getProduct(id: string): Product | undefined {
  return catalog.find((p) => p.id === id);
}

/** Deterministic fallback when the AI is unavailable: exact name or alias match, then substring. */
export function keywordMatch(query: string): Product | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    catalog.find((p) => p.name.toLowerCase() === q || p.aliases.includes(q)) ??
    catalog.find((p) => p.aliases.some((a) => q.includes(a)) || p.name.toLowerCase().includes(q))
  );
}
