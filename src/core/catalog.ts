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
  /** Set on alternatives: the id of the main product they are offered alongside. */
  group?: string;
  /** Pack size in `unit`s (12 rolls, 64 loads), so options can be compared by price per unit. */
  units?: number;
  unit?: string;
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

/** The main product's id for a product's group (a product without `group` leads its own group). */
export function groupOf(product: Product): string {
  return product.group ?? product.id;
}

/** Up to three products in the same group, the group's main product first. */
export function alternativesFor(product: Product): Product[] {
  const group = groupOf(product);
  return catalog.filter((p) => groupOf(p) === group).sort((a, b) => Number(!!a.group) - Number(!!b.group)).slice(0, 3);
}

/** Price per unit in cents, rounded for display ("$0.92/roll"). Undefined without a pack size. */
export function unitCents(p: Product): number | undefined {
  return p.units && p.unit ? Math.round(p.cents / p.units) : undefined;
}

/**
 * The same products, cheapest per unit first, when they all share a unit. Otherwise unchanged.
 * Compares exactly with integer cross-multiplication, so no rounding decides a tie; ties keep catalog order.
 */
export function byUnitPrice(products: Product[]): Product[] {
  const unit = products[0]?.unit;
  if (!unit || products.some((p) => p.unit !== unit || !p.units)) return products;
  return [...products].sort((a, b) => a.cents * b.units! - b.cents * a.units!);
}

export function getProductByName(name: string): Product | undefined {
  return catalog.find((p) => p.name === name);
}
