export type CategoryKey =
  | "produce"
  | "dairy"
  | "meat"
  | "pantry"
  | "frozen"
  | "bakery"
  | "household"
  | "pharmacy"
  | "other";

export type CategoryDefinition = {
  key: CategoryKey;
  label: string;
  sortOrder: number;
};

export const DEFAULT_CATEGORIES: CategoryDefinition[] = [
  { key: "produce", label: "Produce", sortOrder: 10 },
  { key: "dairy", label: "Dairy", sortOrder: 20 },
  { key: "meat", label: "Meat", sortOrder: 30 },
  { key: "pantry", label: "Pantry", sortOrder: 40 },
  { key: "frozen", label: "Frozen", sortOrder: 50 },
  { key: "bakery", label: "Bakery", sortOrder: 60 },
  { key: "household", label: "Household", sortOrder: 70 },
  { key: "pharmacy", label: "Pharmacy", sortOrder: 80 },
  { key: "other", label: "Other", sortOrder: 90 },
];

const KEYWORD_MAP: Array<{ match: RegExp; category: CategoryKey }> = [
  { match: /\b(apple|banana|lettuce|onion|tomato|avocado|pepper|potato|orange|grape)\b/i, category: "produce" },
  { match: /\b(milk|cheese|yogurt|butter|cream|egg)\b/i, category: "dairy" },
  { match: /\b(chicken|beef|pork|fish|salmon|turkey|sausage)\b/i, category: "meat" },
  { match: /\b(rice|pasta|flour|sugar|oil|coffee|tea|cereal|bread crumbs)\b/i, category: "pantry" },
  { match: /\b(ice cream|frozen|pizza)\b/i, category: "frozen" },
  { match: /\b(bread|bagel|bun|croissant|muffin)\b/i, category: "bakery" },
  { match: /\b(soap|shampoo|detergent|refill|trash bag|paper towel|toilet paper)\b/i, category: "household" },
  { match: /\b(toothpaste|vitamin|painkiller|bandage|medicine)\b/i, category: "pharmacy" },
];

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function inferDefaultCategory(name: string): CategoryKey {
  const normalized = normalizeItemName(name);

  for (const entry of KEYWORD_MAP) {
    if (entry.match.test(normalized)) {
      return entry.category;
    }
  }

  return "other";
}

export function sortCategories<T extends { categoryKey: string; completedAt: string | null; createdAt: string }>(
  items: T[],
  categoryOrder: Map<string, number>,
): T[] {
  return [...items].sort((left, right) => {
    const leftOrder = categoryOrder.get(left.categoryKey) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = categoryOrder.get(right.categoryKey) ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (left.completedAt && right.completedAt) {
      return right.completedAt.localeCompare(left.completedAt);
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}
