export type User = {
  id: number;
  email: string;
  displayName: string;
};

export type Household = {
  id: number;
  name: string;
  role: "owner" | "member";
};

export type Category = {
  key: string;
  label: string;
  sortOrder: number;
};

export type ShoppingItem = {
  id: number;
  householdId: number;
  name: string;
  normalizedName: string;
  note: string | null;
  categoryKey: string;
  categoryLabel: string;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type Invite = {
  id: number;
  email: string;
  code: string;
  createdAt: string;
  acceptedAt: string | null;
};

export type SessionPayload = {
  user: User;
  households: Household[];
};

export type HouseholdState = {
  household: Household;
  categories: Category[];
  activeItems: ShoppingItem[];
  completedItems: ShoppingItem[];
  invites: Invite[];
};
