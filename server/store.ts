import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { DEFAULT_CATEGORIES, inferDefaultCategory, normalizeItemName, sortCategories } from "../src/lib/categories.js";
import { ITEM_CATALOG } from "../src/lib/itemCatalog.js";
import type { HouseholdState, ItemSuggestion, SessionPayload, ShoppingListState, ShoppingListSummary } from "../src/lib/types.js";
import { runMigrations } from "./migrate.js";

type Session = {
  token: string;
  userId: number;
  expiresAt: number;
};

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Queryable = {
  query<Result = unknown>(text: string, values?: unknown[]): Promise<{ rows: Result[]; rowCount: number | null }>;
  end?: () => Promise<void>;
};

// test

type UserRecord = {
  id: number;
  email: string;
  displayname: string;
};

type MembershipRecord = {
  role: "owner" | "member";
};

type HouseholdRecord = {
  id: number;
  name: string;
  role: "owner" | "member";
};

type InviteRecord = {
  id: number;
  householdid: number;
  email: string;
  acceptedat: string | null;
};

type ItemRecord = {
  id: number;
  listid: number;
  householdid: number;
  name: string;
  status: "active" | "completed";
  completedat: string | null;
};

type HistoryRecord = {
  normalizedname: string;
  displayname: string;
  usecount: number | string;
  lastusedat: string;
};

function now(): string {
  return new Date().toISOString();
}

function createCode(length = 8): string {
  return randomBytes(length).toString("hex").slice(0, length).toUpperCase();
}

function toIsoString(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function mapUser(row: UserRecord): SessionPayload["user"] {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayname,
  };
}

export class AppStore {
  private readonly db: Queryable;
  private readonly ownsDb: boolean;
  sessions = new Map<string, Session>();

  constructor(options: { connectionString?: string; db?: Queryable }) {
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
      return;
    }

    if (!options.connectionString) {
      throw new Error("AppStore requires either a connection string or a queryable db");
    }

    this.db = new Pool({
      connectionString: options.connectionString,
    });
    this.ownsDb = true;
  }

  async initialize() {
    await runMigrations(this.db);
  }

  getDb() {
    return this.db;
  }

  async close() {
    if (this.ownsDb && this.db.end) {
      await this.db.end();
    }
  }

  async resetForTests() {
    await this.db.query(
      "TRUNCATE TABLE user_item_history, household_item_history, household_categories, invites, household_memberships, items, shopping_lists, households, magic_codes, users RESTART IDENTITY CASCADE",
    );
    this.sessions.clear();
  }

  async requestMagicCode(email: string, displayName?: string) {
    const existingUser = await this.db.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length === 0 && displayName) {
      await this.db.query("INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3)", [
        email,
        displayName.trim(),
        now(),
      ]);
    }

    const code = createCode(6);
    await this.db.query("INSERT INTO magic_codes (email, code, created_at) VALUES ($1, $2, $3)", [email, code, now()]);
    return code;
  }

  async verifyMagicCode(email: string, code: string): Promise<{ token: string; session: SessionPayload } | null> {
    const latest = await this.db.query<{ code: string }>(
      "SELECT code FROM magic_codes WHERE email = $1 ORDER BY id DESC LIMIT 1",
      [email],
    );

    if (latest.rows[0]?.code !== code) {
      return null;
    }

    let userResult = await this.db.query<UserRecord>(
      "SELECT id, email, display_name AS displayName FROM users WHERE email = $1",
      [email],
    );

    if (userResult.rows.length === 0) {
      const name = email.split("@")[0];
      userResult = await this.db.query<UserRecord>(
        "INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3) RETURNING id, email, display_name AS displayName",
        [email, name, now()],
      );
    }

    const user = mapUser(userResult.rows[0]);
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });

    return {
      token,
      session: await this.getSessionPayload(user.id),
    };
  }

  getUserIdFromToken(token: string | undefined): number | null {
    if (!token) {
      return null;
    }

    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session.userId;
  }

  async getSessionPayload(userId: number): Promise<SessionPayload> {
    const userResult = await this.db.query<UserRecord>(
      "SELECT id, email, display_name AS displayName FROM users WHERE id = $1",
      [userId],
    );
    const householdsResult = await this.db.query<HouseholdRecord>(
      `
        SELECT households.id, households.name, household_memberships.role
        FROM households
        JOIN household_memberships ON household_memberships.household_id = households.id
        WHERE household_memberships.user_id = $1
        ORDER BY households.name
      `,
      [userId],
    );

    return {
      user: mapUser(userResult.rows[0]),
      households: householdsResult.rows.map((row) => ({ id: row.id, name: row.name, role: row.role })),
    };
  }

  async createHousehold(userId: number, name: string) {
    const createdAt = now();
    const householdResult = await this.db.query<{ id: number }>(
      "INSERT INTO households (name, created_at) VALUES ($1, $2) RETURNING id",
      [name, createdAt],
    );
    const householdId = householdResult.rows[0].id;

    await this.db.query(
      "INSERT INTO household_memberships (user_id, household_id, role, created_at) VALUES ($1, $2, 'owner', $3)",
      [userId, householdId, createdAt],
    );

    for (const category of DEFAULT_CATEGORIES) {
      await this.db.query(
        "INSERT INTO household_categories (household_id, category_key, label, sort_order) VALUES ($1, $2, $3, $4)",
        [householdId, category.key, category.label, category.sortOrder],
      );
    }

    await this.db.query("INSERT INTO shopping_lists (household_id, name, created_at) VALUES ($1, $2, $3)", [
      householdId,
      "Groceries",
      createdAt,
    ]);

    return this.getSessionPayload(userId);
  }

  async ensureMembership(userId: number, householdId: number) {
    const membership = await this.db.query<MembershipRecord>(
      "SELECT role FROM household_memberships WHERE user_id = $1 AND household_id = $2",
      [userId, householdId],
    );

    if (membership.rows.length === 0) {
      throw new Error("Forbidden");
    }

    return membership.rows[0];
  }

  async createInvite(userId: number, householdId: number, email: string) {
    await this.ensureMembership(userId, householdId);
    const code = createCode(10);
    await this.db.query(
      "INSERT INTO invites (household_id, email, code, created_at) VALUES ($1, $2, $3, $4)",
      [householdId, email, code, now()],
    );
    return code;
  }

  async getInvitePreview(code: string) {
    const inviteResult = await this.db.query<{
      email: string;
      householdname: string;
      acceptedat: string | null;
    }>(
      `
        SELECT invites.email,
               households.name AS householdName,
               invites.accepted_at AS acceptedAt
        FROM invites
        JOIN households ON households.id = invites.household_id
        WHERE invites.code = $1
      `,
      [code],
    );
    const invite = inviteResult.rows[0];
    if (!invite || invite.acceptedat) {
      throw new Error("Invite not found");
    }

    return {
      email: invite.email,
      householdName: invite.householdname,
    };
  }

  async deletePendingInvite(userId: number, inviteId: number) {
    const inviteResult = await this.db.query<{ householdid: number; acceptedat: string | null }>(
      "SELECT household_id AS householdId, accepted_at AS acceptedAt FROM invites WHERE id = $1",
      [inviteId],
    );
    const invite = inviteResult.rows[0];
    if (!invite || invite.acceptedat) {
      throw new Error("Invite not found");
    }

    await this.ensureMembership(userId, invite.householdid);
    await this.db.query("DELETE FROM invites WHERE id = $1", [inviteId]);
    return invite.householdid;
  }

  async acceptInvite(userId: number, code: string) {
    const inviteResult = await this.db.query<InviteRecord>(
      "SELECT id, household_id AS householdId, email, accepted_at AS acceptedAt FROM invites WHERE code = $1",
      [code],
    );
    const invite = inviteResult.rows[0];
    if (!invite || invite.acceptedat) {
      throw new Error("Invite not found");
    }

    const userResult = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    if (userResult.rows[0]?.email !== invite.email) {
      throw new Error("Invite email does not match the current account");
    }

    const createdAt = now();
    await this.db.query(
      `
        INSERT INTO household_memberships (user_id, household_id, role, created_at)
        VALUES ($1, $2, 'member', $3)
        ON CONFLICT (user_id, household_id) DO NOTHING
      `,
      [userId, invite.householdid, createdAt],
    );
    await this.db.query("UPDATE invites SET accepted_at = $1 WHERE id = $2", [createdAt, invite.id]);

    return this.getSessionPayload(userId);
  }

  async resolveCategory(_householdId: number, name: string) {
    return inferDefaultCategory(name);
  }

  async addItem(userId: number, householdId: number, name: string) {
    await this.ensureMembership(userId, householdId);
    const listResult = await this.db.query<{ id: number }>(
      "SELECT id FROM shopping_lists WHERE household_id = $1 ORDER BY id LIMIT 1",
      [householdId],
    );
    const listId = listResult.rows[0]?.id;
    if (!listId) {
      throw new Error("List not found");
    }
    return this.addListItem(userId, listId, name);
  }

  async addListItem(userId: number, listId: number, name: string) {
    const list = await this.ensureListAccess(userId, listId);
    const timestamp = now();
    const normalized = normalizeItemName(name);
    const existingActive = await this.db.query<{ id: number }>(
      "SELECT id FROM items WHERE list_id = $1 AND normalized_name = $2 AND status = 'active' ORDER BY id LIMIT 1",
      [listId, normalized],
    );
    if (existingActive.rows[0]) {
      await this.recordItemHistory(userId, list.householdId, name, timestamp);
      return existingActive.rows[0].id;
    }

    const categoryKey = await this.resolveCategory(list.householdId, name);
    const result = await this.db.query<{ id: number }>(
      `
        INSERT INTO items (household_id, list_id, name, normalized_name, category_key, status, created_at, updated_at, completed_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, NULL)
        RETURNING id
      `,
      [list.householdId, listId, name.trim(), normalized, categoryKey, timestamp, timestamp],
    );
    await this.recordItemHistory(userId, list.householdId, name, timestamp);
    return result.rows[0].id;
  }

  async recordItemHistory(userId: number, householdId: number, name: string, timestamp = now()) {
    const displayName = name.trim();
    const normalized = normalizeItemName(displayName);
    if (!normalized) {
      return;
    }

    await this.db.query(
      `
        INSERT INTO user_item_history (user_id, normalized_name, display_name, use_count, last_used_at)
        VALUES ($1, $2, $3, 1, $4)
        ON CONFLICT (user_id, normalized_name)
        DO UPDATE SET display_name = EXCLUDED.display_name,
                      use_count = user_item_history.use_count + 1,
                      last_used_at = EXCLUDED.last_used_at
      `,
      [userId, normalized, displayName, timestamp],
    );
    await this.db.query(
      `
        INSERT INTO household_item_history (household_id, normalized_name, display_name, use_count, last_used_at)
        VALUES ($1, $2, $3, 1, $4)
        ON CONFLICT (household_id, normalized_name)
        DO UPDATE SET display_name = EXCLUDED.display_name,
                      use_count = household_item_history.use_count + 1,
                      last_used_at = EXCLUDED.last_used_at
      `,
      [householdId, normalized, displayName, timestamp],
    );
  }

  async getItemSuggestions(userId: number, listId: number, query: string): Promise<ItemSuggestion[]> {
    const list = await this.ensureListAccess(userId, listId);
    const normalizedQuery = normalizeItemName(query);
    const pattern = `${normalizedQuery}%`;
    const scored = new Map<string, ItemSuggestion & { score: number }>();

    const addSuggestion = (suggestion: ItemSuggestion, useCount: number, lastUsedAt: string | null) => {
      const startsWithQuery = normalizedQuery ? suggestion.normalizedName.startsWith(normalizedQuery) : true;
      const exactQuery = normalizedQuery ? suggestion.normalizedName === normalizedQuery : false;
      const sourceScore = suggestion.source === "user" ? 300 : suggestion.source === "household" ? 200 : 100;
      const recencyScore = lastUsedAt ? Math.max(0, Date.parse(lastUsedAt) / 100000000000) : 0;
      const score = sourceScore + useCount * 8 + recencyScore + (startsWithQuery ? 80 : 0) + (exactQuery ? 500 : 0);
      const existing = scored.get(suggestion.normalizedName);
      if (!existing || score > existing.score) {
        scored.set(suggestion.normalizedName, { ...suggestion, score });
      }
    };

    const userHistory = await this.db.query<HistoryRecord>(
      `
        SELECT normalized_name AS normalizedName,
               display_name AS displayName,
               use_count AS useCount,
               last_used_at AS lastUsedAt
        FROM user_item_history
        WHERE user_id = $1
          AND ($2 = '' OR normalized_name LIKE $3)
        ORDER BY use_count DESC, last_used_at DESC
        LIMIT 12
      `,
      [userId, normalizedQuery, pattern],
    );
    for (const row of userHistory.rows) {
      addSuggestion(
        { name: row.displayname, normalizedName: row.normalizedname, source: "user" },
        Number(row.usecount),
        row.lastusedat,
      );
    }

    const householdHistory = await this.db.query<HistoryRecord>(
      `
        SELECT normalized_name AS normalizedName,
               display_name AS displayName,
               use_count AS useCount,
               last_used_at AS lastUsedAt
        FROM household_item_history
        WHERE household_id = $1
          AND ($2 = '' OR normalized_name LIKE $3)
        ORDER BY use_count DESC, last_used_at DESC
        LIMIT 12
      `,
      [list.householdId, normalizedQuery, pattern],
    );
    for (const row of householdHistory.rows) {
      addSuggestion(
        { name: row.displayname, normalizedName: row.normalizedname, source: "household" },
        Number(row.usecount),
        row.lastusedat,
      );
    }

    for (const item of ITEM_CATALOG) {
      if (!normalizedQuery || item.normalizedName.startsWith(normalizedQuery)) {
        addSuggestion({ name: item.name, normalizedName: item.normalizedName, source: "catalog" }, 1, null);
      }
    }

    return [...scored.values()]
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 8)
      .map(({ score: _score, ...suggestion }) => suggestion);
  }

  async updateItem(
    userId: number,
    itemId: number,
    patch: { name?: string; status?: "active" | "completed" },
  ) {
    const itemResult = await this.db.query<ItemRecord>(
      "SELECT id, list_id AS listId, household_id AS householdId, name, status, completed_at AS completedAt FROM items WHERE id = $1",
      [itemId],
    );
    const item = itemResult.rows[0];
    if (!item) {
      throw new Error("Item not found");
    }
    await this.ensureMembership(userId, item.householdid);

    const nextName = patch.name?.trim() || item.name;
    const nextNormalized = normalizeItemName(nextName);
    const nextCategory = await this.resolveCategory(item.householdid, nextName);
    const nextStatus = patch.status ?? item.status;
    const completedAt = nextStatus === "completed" ? item.completedat ?? now() : null;

    await this.db.query(
      `
        UPDATE items
        SET name = $1,
            normalized_name = $2,
            category_key = $3,
            status = $4,
            updated_at = $5,
            completed_at = $6
        WHERE id = $7
      `,
      [nextName, nextNormalized, nextCategory, nextStatus, now(), completedAt, itemId],
    );
  }

  async getItemHouseholdId(itemId: number) {
    const result = await this.db.query<{ householdid: number }>(
      "SELECT household_id AS householdId FROM items WHERE id = $1",
      [itemId],
    );
    return result.rows[0]?.householdid ?? null;
  }

  async getItemListId(itemId: number) {
    const result = await this.db.query<{ listid: number }>("SELECT list_id AS listId FROM items WHERE id = $1", [itemId]);
    return result.rows[0]?.listid ?? null;
  }

  async ensureListAccess(userId: number, listId: number) {
    const result = await this.db.query<{ id: number; household_id: number; household_name: string; list_name: string; created_at: string }>(
      `
        SELECT shopping_lists.id,
               shopping_lists.household_id AS household_id,
               households.name AS household_name,
               shopping_lists.name AS list_name,
               shopping_lists.created_at AS created_at
        FROM shopping_lists
        JOIN households ON households.id = shopping_lists.household_id
        JOIN household_memberships ON household_memberships.household_id = households.id
        WHERE shopping_lists.id = $1
          AND household_memberships.user_id = $2
      `,
      [listId, userId],
    );
    const list = result.rows[0];
    if (!list) {
      throw new Error("Forbidden");
    }
    return {
      id: list.id,
      householdId: list.household_id,
      householdName: list.household_name,
      name: list.list_name,
      createdAt: toIsoString(list.created_at)!,
    };
  }

  async getListHouseholdId(listId: number) {
    const result = await this.db.query<{ householdid: number }>(
      "SELECT household_id AS householdId FROM shopping_lists WHERE id = $1",
      [listId],
    );
    return result.rows[0]?.householdid ?? null;
  }

  async createList(userId: number, householdId: number, name: string) {
    await this.ensureMembership(userId, householdId);
    const result = await this.db.query<{ id: number }>(
      "INSERT INTO shopping_lists (household_id, name, created_at) VALUES ($1, $2, $3) RETURNING id",
      [householdId, name, now()],
    );
    return result.rows[0].id;
  }

  async getListSummaries(userId: number): Promise<ShoppingListSummary[]> {
    const householdsResult = await this.db.query<{ id: number; name: string }>(
      `
        SELECT households.id, households.name
        FROM households
        JOIN household_memberships ON household_memberships.household_id = households.id
        WHERE household_memberships.user_id = $1
      `,
      [userId],
    );
    const householdNames = new Map(householdsResult.rows.map((household) => [household.id, household.name]));
    const result = await this.db.query<{
      id: number;
      household_id: number;
      list_name: string;
      created_at: string;
      active_count: string | number;
      completed_count: string | number;
    }>(
      `
        SELECT shopping_lists.id,
               shopping_lists.household_id AS household_id,
               shopping_lists.name AS list_name,
               shopping_lists.created_at AS created_at,
               COUNT(items.id) FILTER (WHERE items.status = 'active') AS active_count,
               COUNT(items.id) FILTER (WHERE items.status = 'completed') AS completed_count
        FROM shopping_lists
        JOIN households ON households.id = shopping_lists.household_id
        JOIN household_memberships ON household_memberships.household_id = households.id
        LEFT JOIN items ON items.list_id = shopping_lists.id
        WHERE household_memberships.user_id = $1
        GROUP BY shopping_lists.id, shopping_lists.household_id, shopping_lists.name, shopping_lists.created_at
        ORDER BY shopping_lists.name
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      householdId: row.household_id,
      householdName: householdNames.get(row.household_id) ?? "",
      name: row.list_name,
      createdAt: toIsoString(row.created_at)!,
      activeCount: Number(row.active_count),
      completedCount: Number(row.completed_count),
    }));
  }

  async getHousehold(userId: number, householdId: number) {
    await this.ensureMembership(userId, householdId);
    const result = await this.db.query<{ id: number; name: string }>(
      "SELECT id, name FROM households WHERE id = $1",
      [householdId],
    );
    return result.rows[0] ?? null;
  }

  async leaveHousehold(userId: number, householdId: number) {
    await this.ensureMembership(userId, householdId);
    await this.db.query("DELETE FROM household_memberships WHERE user_id = $1 AND household_id = $2", [
      userId,
      householdId,
    ]);
    return this.getSessionPayload(userId);
  }

  async getHouseholdState(userId: number, householdId: number): Promise<HouseholdState> {
    const membership = await this.ensureMembership(userId, householdId);
    const householdResult = await this.db.query<{ id: number; name: string }>(
      "SELECT id, name FROM households WHERE id = $1",
      [householdId],
    );
    const categoriesResult = await this.db.query<{ key: string; label: string; sortorder: number }>(
      "SELECT category_key AS key, label, sort_order AS sortOrder FROM household_categories WHERE household_id = $1 ORDER BY sort_order",
      [householdId],
    );
    const categoryMap = new Map(categoriesResult.rows.map((category) => [category.key, category.sortorder]));
    const rowsResult = await this.db.query<{
      id: number;
      listid: number;
      householdid: number;
      name: string;
      normalizedname: string;
      categorykey: string;
      categorylabel: string;
      status: "active" | "completed";
      createdat: string;
      updatedat: string;
      completedat: string | null;
    }>(
      `
        SELECT items.id,
               items.list_id AS listId,
               items.household_id AS householdId,
               items.name,
               items.normalized_name AS normalizedName,
               items.category_key AS categoryKey,
               household_categories.label AS categoryLabel,
               items.status,
               items.created_at AS createdAt,
               items.updated_at AS updatedAt,
               items.completed_at AS completedAt
        FROM items
        JOIN household_categories
          ON household_categories.household_id = items.household_id
         AND household_categories.category_key = items.category_key
        WHERE items.household_id = $1
      `,
      [householdId],
    );
    const invitesResult = await this.db.query<{
      id: number;
      email: string;
      code: string;
      createdat: string;
      acceptedat: string | null;
    }>(
      "SELECT id, email, code, created_at AS createdAt, accepted_at AS acceptedAt FROM invites WHERE household_id = $1 ORDER BY created_at DESC",
      [householdId],
    );

    const rows = rowsResult.rows.map((item) => ({
      id: item.id,
      listId: item.listid,
      householdId: item.householdid,
      name: item.name,
      normalizedName: item.normalizedname,
      categoryKey: item.categorykey,
      categoryLabel: item.categorylabel,
      status: item.status,
      createdAt: toIsoString(item.createdat)!,
      updatedAt: toIsoString(item.updatedat)!,
      completedAt: toIsoString(item.completedat),
    }));

    const activeItems = sortCategories(
      rows.filter((item) => item.status === "active"),
      categoryMap,
    );
    const completedItems = sortCategories(
      rows.filter((item) => item.status === "completed"),
      categoryMap,
    );

    return {
      household: { ...householdResult.rows[0], role: membership.role },
      categories: categoriesResult.rows.map((category) => ({
        key: category.key,
        label: category.label,
        sortOrder: category.sortorder,
      })),
      activeItems,
      completedItems,
      invites: invitesResult.rows.map((invite) => ({
        id: invite.id,
        email: invite.email,
        code: invite.code,
        createdAt: invite.createdat,
        acceptedAt: invite.acceptedat,
      })),
    };
  }

  async getListState(userId: number, listId: number): Promise<ShoppingListState> {
    const list = await this.ensureListAccess(userId, listId);
    const categoriesResult = await this.db.query<{ key: string; label: string; sortorder: number }>(
      "SELECT category_key AS key, label, sort_order AS sortOrder FROM household_categories WHERE household_id = $1 ORDER BY sort_order",
      [list.householdId],
    );
    const categoryMap = new Map(categoriesResult.rows.map((category) => [category.key, category.sortorder]));
    const rowsResult = await this.db.query<{
      id: number;
      listid: number;
      householdid: number;
      name: string;
      normalizedname: string;
      categorykey: string;
      categorylabel: string;
      status: "active" | "completed";
      createdat: string;
      updatedat: string;
      completedat: string | null;
    }>(
      `
        SELECT items.id,
               items.list_id AS listId,
               items.household_id AS householdId,
               items.name,
               items.normalized_name AS normalizedName,
               items.category_key AS categoryKey,
               household_categories.label AS categoryLabel,
               items.status,
               items.created_at AS createdAt,
               items.updated_at AS updatedAt,
               items.completed_at AS completedAt
        FROM items
        JOIN household_categories
          ON household_categories.household_id = items.household_id
         AND household_categories.category_key = items.category_key
        WHERE items.list_id = $1
      `,
      [listId],
    );

    const rows = rowsResult.rows.map((item) => ({
      id: item.id,
      listId: item.listid,
      householdId: item.householdid,
      name: item.name,
      normalizedName: item.normalizedname,
      categoryKey: item.categorykey,
      categoryLabel: item.categorylabel,
      status: item.status,
      createdAt: toIsoString(item.createdat)!,
      updatedAt: toIsoString(item.updatedat)!,
      completedAt: toIsoString(item.completedat),
    }));

    return {
      list,
      categories: categoriesResult.rows.map((category) => ({
        key: category.key,
        label: category.label,
        sortOrder: category.sortorder,
      })),
      activeItems: sortCategories(
        rows.filter((item) => item.status === "active"),
        categoryMap,
      ),
      completedItems: sortCategories(
        rows.filter((item) => item.status === "completed"),
        categoryMap,
      ),
    };
  }
}
