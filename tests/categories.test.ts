import { describe, expect, test } from "vitest";
import { inferDefaultCategory, normalizeItemName, sortCategories } from "../src/lib/categories";

describe("categories", () => {
  test("normalizes names for reuse", () => {
    expect(normalizeItemName("  SOAP   refill ")).toBe("soap refill");
  });

  test("infers household category from keywords", () => {
    expect(inferDefaultCategory("Shampoo")).toBe("household");
    expect(inferDefaultCategory("Milk")).toBe("dairy");
  });

  test("sorts by category and then time", () => {
    const ordered = sortCategories(
      [
        { categoryKey: "pantry", completedAt: null, createdAt: "2026-04-18T11:00:00.000Z" },
        { categoryKey: "produce", completedAt: null, createdAt: "2026-04-18T10:00:00.000Z" },
      ],
      new Map([
        ["produce", 10],
        ["pantry", 20],
      ]),
    );

    expect(ordered[0].categoryKey).toBe("produce");
  });
});
