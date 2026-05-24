export type User = {
  id: number;
  email: string;
  displayName: string;
};

export type ShoppingList = {
  id: number;
  ownerId: number;
  ownerName: string;
  name: string;
  createdAt: string;
};

export type ShoppingListSummary = ShoppingList & {
  activeCount: number;
  completedCount: number;
  shared: boolean;
};

export type Category = {
  key: string;
  label: string;
  sortOrder: number;
};

export type ShoppingItem = {
  id: number;
  listId: number;
  name: string;
  normalizedName: string;
  categoryKey: string;
  categoryLabel: string;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ItemSuggestion = {
  name: string;
  normalizedName: string;
  source: "catalog" | "user" | "list";
};

export type SessionPayload = {
  user: User;
  defaultShareEmails: string[];
};

export type ShareSettings = {
  emails: string[];
};

export type ShoppingListState = {
  list: ShoppingList;
  categories: Category[];
  activeItems: ShoppingItem[];
  completedItems: ShoppingItem[];
};
