import { normalizeItemName } from "./categories.js";

export type CatalogItem = {
  name: string;
  normalizedName: string;
};

const CATALOG_NAMES = [
  "Apples",
  "Avocados",
  "Bananas",
  "Blueberries",
  "Bread",
  "Butter",
  "Carrots",
  "Cereal",
  "Cheese",
  "Chicken",
  "Coffee",
  "Cream",
  "Eggs",
  "Flour",
  "Garlic",
  "Ground beef",
  "Ice cream",
  "Lettuce",
  "Milk",
  "Onions",
  "Orange juice",
  "Pasta",
  "Peanut butter",
  "Potatoes",
  "Rice",
  "Salmon",
  "Soap",
  "Spinach",
  "Sugar",
  "Tea",
  "Toilet paper",
  "Tomatoes",
  "Trash bags",
  "Yogurt",
];

export const ITEM_CATALOG: CatalogItem[] = CATALOG_NAMES.map((name) => ({
  name,
  normalizedName: normalizeItemName(name),
}));
