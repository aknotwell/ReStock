// Person 1 demo catalog. Prices are application data, never model output.
export const CATALOG = [
  { id: "tp", name: "Toilet paper, 12 rolls", cents: 1199, shared: true, aliases: ["tp", "toilet paper"] },
  { id: "soap", name: "Dish soap, 3 pack", cents: 849, shared: true, aliases: ["dish soap", "dishwashing liquid"] },
  { id: "towels", name: "Paper towels, 6 rolls", cents: 999, shared: true, aliases: ["paper towels", "paper towel"] },
  { id: "fryer", name: "Air fryer", cents: 3200, shared: false, aliases: ["air fryer"] },
  { id: "chips", name: "Tortilla chips", cents: 479, shared: false, aliases: ["chips", "tortilla chips"] },
  { id: "milk", name: "Oat milk", cents: 549, shared: false, aliases: ["oat milk"] },
] as const;

export type Product = (typeof CATALOG)[number];
export const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function matchProducts(query: string): { exact?: Product; candidates: Product[] } {
  const normalized = normalize(query);
  const exact = CATALOG.find((p) => [p.name, ...p.aliases].some((name) => normalize(name) === normalized));
  if (exact) return { exact, candidates: [exact] };
  const words = normalized.split(" ").filter((word) => word.length > 2);
  const candidates = CATALOG.filter((p) => words.some((word) => normalize(p.name).split(" ").includes(word)));
  return { candidates: [...candidates] };
}

export function linePrice(product: Product, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("Quantity must be from 1 to 20 packs.");
  return product.cents * quantity;
}
