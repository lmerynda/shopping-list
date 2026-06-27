import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { DEFAULT_CATEGORIES, inferDefaultCategory, normalizeItemName, sortCategories } from "../src/lib/categories.js";
import { ITEM_CATALOG } from "../src/lib/itemCatalog.js";
import type { ItemSuggestion, SessionPayload, ShoppingListState, ShoppingListSummary } from "../src/lib/types.js";
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

type UserRecord = {
  id: number;
  email: string;
  displayname: string;
};

type ItemRecord = {
  id: number;
  listid: number;
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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function uniqueEmails(emails: string[]) {
  return [...new Set(emails.map(normalizeEmail).filter(Boolean))].sort();
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

    this.db = new Pool({ connectionString: options.connectionString });
    this.ownsDb = true;
  }

  async initialize() {
    await runMigrations(this.db);
  }

  async close() {
    if (this.ownsDb && this.db.end) {
      await this.db.end();
    }
  }

  async resetForTests() {
    await this.db.query(
      "TRUNCATE TABLE list_item_history, user_item_history, items, list_shares, default_shares, shopping_lists, magic_codes, users RESTART IDENTITY CASCADE",
    );
    this.sessions.clear();
  }

  async requestMagicCode(email: string, displayName?: string) {
    const normalizedEmail = normalizeEmail(email);
    const existingUser = await this.db.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (existingUser.rows.length === 0 && displayName) {
      const userResult = await this.db.query<{ id: number }>(
        "INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3) RETURNING id",
        [normalizedEmail, displayName.trim(), now()],
      );
      await this.ensureDefaultList(userResult.rows[0].id);
    }

    const code = createCode(6);
    await this.db.query("INSERT INTO magic_codes (email, code, created_at) VALUES ($1, $2, $3)", [
      normalizedEmail,
      code,
      now(),
    ]);
    return code;
  }

  async verifyMagicCode(email: string, code: string): Promise<{ token: string; session: SessionPayload } | null> {
    const normalizedEmail = normalizeEmail(email);
    const latest = await this.db.query<{ code: string }>(
      "SELECT code FROM magic_codes WHERE email = $1 ORDER BY id DESC LIMIT 1",
      [normalizedEmail],
    );

    if (latest.rows[0]?.code !== code) {
      return null;
    }

    let userResult = await this.db.query<UserRecord>(
      "SELECT id, email, display_name AS displayName FROM users WHERE email = $1",
      [normalizedEmail],
    );

    if (userResult.rows.length === 0) {
      const name = normalizedEmail.split("@")[0];
      userResult = await this.db.query<UserRecord>(
        "INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3) RETURNING id, email, display_name AS displayName",
        [normalizedEmail, name, now()],
      );
      await this.ensureDefaultList(userResult.rows[0].id);
    }

    const user = mapUser(userResult.rows[0]);
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });

    return {
      token,
      session: await this.getSessionPayload(user.id),
    };
  }

  async devLogin(email: string, displayName?: string): Promise<{ token: string; session: SessionPayload }> {
    const normalizedEmail = normalizeEmail(email);

    let userResult = await this.db.query<UserRecord>(
      "SELECT id, email, display_name AS displayName FROM users WHERE email = $1",
      [normalizedEmail],
    );

    if (userResult.rows.length === 0) {
      const name = (displayName?.trim() || normalizedEmail.split("@")[0]);
      userResult = await this.db.query<UserRecord>(
        "INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3) RETURNING id, email, display_name AS displayName",
        [normalizedEmail, name, now()],
      );
      await this.ensureDefaultList(userResult.rows[0].id);
    } else if (displayName && displayName.trim()) {
      // Optionally update display name if provided on subsequent dev logins
      await this.db.query(
        "UPDATE users SET display_name = $1 WHERE email = $2 AND display_name <> $1",
        [displayName.trim(), normalizedEmail],
      );
      userResult = await this.db.query<UserRecord>(
        "SELECT id, email, display_name AS displayName FROM users WHERE email = $1",
        [normalizedEmail],
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
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
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
    return {
      user: mapUser(userResult.rows[0]),
      defaultShareEmails: await this.getDefaultShareEmails(userId),
    };
  }

  async ensureDefaultList(userId: number) {
    const existing = await this.db.query<{ id: number }>("SELECT id FROM shopping_lists WHERE owner_id = $1 LIMIT 1", [
      userId,
    ]);
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    return this.createList(userId, "Groceries");
  }

  async getDefaultShareEmails(userId: number) {
    const result = await this.db.query<{ email: string }>(
      "SELECT email FROM default_shares WHERE user_id = $1 ORDER BY email",
      [userId],
    );
    return result.rows.map((row) => row.email);
  }

  async updateDefaultShareEmails(userId: number, emails: string[]) {
    const normalizedEmails = uniqueEmails(emails);
    await this.db.query("DELETE FROM default_shares WHERE user_id = $1", [userId]);
    for (const email of normalizedEmails) {
      await this.db.query("INSERT INTO default_shares (user_id, email, created_at) VALUES ($1, $2, $3)", [
        userId,
        email,
        now(),
      ]);
    }
    return { emails: normalizedEmails };
  }

  resolveCategory(name: string) {
    return inferDefaultCategory(name);
  }

  async createList(userId: number, name: string) {
    const timestamp = now();
    const result = await this.db.query<{ id: number }>(
      "INSERT INTO shopping_lists (owner_id, name, created_at) VALUES ($1, $2, $3) RETURNING id",
      [userId, name.trim(), timestamp],
    );
    const listId = result.rows[0].id;
    for (const email of await this.getDefaultShareEmails(userId)) {
      await this.db.query("INSERT INTO list_shares (list_id, email, created_at) VALUES ($1, $2, $3)", [
        listId,
        email,
        timestamp,
      ]);
    }
    return listId;
  }

  async deleteList(userId: number, listId: number) {
    const result = await this.db.query<{ id: number }>(
      "DELETE FROM shopping_lists WHERE id = $1 AND owner_id = $2 RETURNING id",
      [listId, userId],
    );
    if (!result.rows[0]) {
      throw new Error("Forbidden");
    }
  }

  async ensureListAccess(userId: number, listId: number) {
    const userResult = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    const email = userResult.rows[0]?.email;
    const result = await this.db.query<{
      id: number;
      ownerid: number;
      ownername: string;
      name: string;
      createdat: string;
    }>(
      `
        SELECT shopping_lists.id,
               shopping_lists.owner_id AS ownerId,
               users.display_name AS ownerName,
               shopping_lists.name,
               shopping_lists.created_at AS createdAt
        FROM shopping_lists
        JOIN users ON users.id = shopping_lists.owner_id
        LEFT JOIN list_shares ON list_shares.list_id = shopping_lists.id
        WHERE shopping_lists.id = $1
          AND (shopping_lists.owner_id = $2 OR list_shares.email = $3)
        LIMIT 1
      `,
      [listId, userId, email],
    );
    const list = result.rows[0];
    if (!list) {
      throw new Error("Forbidden");
    }
    return {
      id: list.id,
      ownerId: list.ownerid,
      ownerName: list.ownername,
      name: list.name,
      createdAt: toIsoString(list.createdat)!,
    };
  }

  async addListItem(userId: number, listId: number, name: string) {
    await this.ensureListAccess(userId, listId);
    const timestamp = now();
    const normalized = normalizeItemName(name);
    const existingActive = await this.db.query<{ id: number }>(
      "SELECT id FROM items WHERE list_id = $1 AND normalized_name = $2 AND status = 'active' ORDER BY id LIMIT 1",
      [listId, normalized],
    );
    if (existingActive.rows[0]) {
      await this.recordItemHistory(userId, listId, name, timestamp);
      return existingActive.rows[0].id;
    }

    const categoryKey = this.resolveCategory(name);
    const result = await this.db.query<{ id: number }>(
      `
        INSERT INTO items (list_id, name, normalized_name, category_key, status, created_at, updated_at, completed_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $6, NULL)
        RETURNING id
      `,
      [listId, name.trim(), normalized, categoryKey, timestamp, timestamp],
    );
    await this.recordItemHistory(userId, listId, name, timestamp);
    return result.rows[0].id;
  }

  async recordItemHistory(userId: number, listId: number, name: string, timestamp = now()) {
    const displayName = name.trim();
    const normalized = normalizeItemName(displayName);
    if (!normalized) return;

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
        INSERT INTO list_item_history (list_id, normalized_name, display_name, use_count, last_used_at)
        VALUES ($1, $2, $3, 1, $4)
        ON CONFLICT (list_id, normalized_name)
        DO UPDATE SET display_name = EXCLUDED.display_name,
                      use_count = list_item_history.use_count + 1,
                      last_used_at = EXCLUDED.last_used_at
      `,
      [listId, normalized, displayName, timestamp],
    );
  }

  async getItemSuggestions(userId: number, listId: number, query: string): Promise<ItemSuggestion[]> {
    await this.ensureListAccess(userId, listId);
    const normalizedQuery = normalizeItemName(query);
    const pattern = `${normalizedQuery}%`;
    const scored = new Map<string, ItemSuggestion & { score: number }>();

    const addSuggestion = (suggestion: ItemSuggestion, useCount: number, lastUsedAt: string | null) => {
      const startsWithQuery = normalizedQuery ? suggestion.normalizedName.startsWith(normalizedQuery) : true;
      const exactQuery = normalizedQuery ? suggestion.normalizedName === normalizedQuery : false;
      const sourceScore = suggestion.source === "user" ? 300 : suggestion.source === "list" ? 200 : 100;
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

    const listHistory = await this.db.query<HistoryRecord>(
      `
        SELECT normalized_name AS normalizedName,
               display_name AS displayName,
               use_count AS useCount,
               last_used_at AS lastUsedAt
        FROM list_item_history
        WHERE list_id = $1
          AND ($2 = '' OR normalized_name LIKE $3)
        ORDER BY use_count DESC, last_used_at DESC
        LIMIT 12
      `,
      [listId, normalizedQuery, pattern],
    );
    for (const row of listHistory.rows) {
      addSuggestion(
        { name: row.displayname, normalizedName: row.normalizedname, source: "list" },
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

  async updateItem(userId: number, itemId: number, patch: { name?: string; status?: "active" | "completed" }) {
    const itemResult = await this.db.query<ItemRecord>(
      "SELECT id, list_id AS listId, name, status, completed_at AS completedAt FROM items WHERE id = $1",
      [itemId],
    );
    const item = itemResult.rows[0];
    if (!item) {
      throw new Error("Item not found");
    }
    await this.ensureListAccess(userId, item.listid);

    const nextName = patch.name?.trim() || item.name;
    const nextNormalized = normalizeItemName(nextName);
    const nextCategory = this.resolveCategory(nextName);
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

  async getItemListId(itemId: number) {
    const result = await this.db.query<{ listid: number }>("SELECT list_id AS listId FROM items WHERE id = $1", [itemId]);
    return result.rows[0]?.listid ?? null;
  }

  async getListSummaries(userId: number): Promise<ShoppingListSummary[]> {
    const userResult = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    const email = userResult.rows[0]?.email;
    const result = await this.db.query<{
      id: number;
      ownerid: number;
      ownername: string;
      name: string;
      createdat: string;
      activecount: string | number;
      completedcount: string | number;
      shared: boolean;
    }>(
      `
        SELECT shopping_lists.id,
               shopping_lists.owner_id AS ownerId,
               users.display_name AS ownerName,
               shopping_lists.name,
               shopping_lists.created_at AS createdAt,
               COUNT(items.id) FILTER (WHERE items.status = 'active') AS activeCount,
               COUNT(items.id) FILTER (WHERE items.status = 'completed') AS completedCount,
               shopping_lists.owner_id <> $1 AS shared
        FROM shopping_lists
        JOIN users ON users.id = shopping_lists.owner_id
        LEFT JOIN list_shares ON list_shares.list_id = shopping_lists.id
        LEFT JOIN items ON items.list_id = shopping_lists.id
        WHERE shopping_lists.owner_id = $1 OR list_shares.email = $2
        GROUP BY shopping_lists.id, shopping_lists.owner_id, users.display_name, shopping_lists.name, shopping_lists.created_at
        ORDER BY shopping_lists.name
      `,
      [userId, email],
    );

    return result.rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerid,
      ownerName: row.ownername,
      name: row.name,
      createdAt: toIsoString(row.createdat)!,
      activeCount: Number(row.activecount),
      completedCount: Number(row.completedcount),
      shared: row.shared,
    }));
  }

  async getListState(userId: number, listId: number): Promise<ShoppingListState> {
    const list = await this.ensureListAccess(userId, listId);
    const categoryMap = new Map<string, number>(DEFAULT_CATEGORIES.map((category) => [category.key, category.sortOrder]));
    const categoryLabels = new Map<string, string>(DEFAULT_CATEGORIES.map((category) => [category.key, category.label]));
    const rowsResult = await this.db.query<{
      id: number;
      listid: number;
      name: string;
      normalizedname: string;
      categorykey: string;
      status: "active" | "completed";
      createdat: string;
      updatedat: string;
      completedat: string | null;
    }>(
      `
        SELECT id,
               list_id AS listId,
               name,
               normalized_name AS normalizedName,
               category_key AS categoryKey,
               status,
               created_at AS createdAt,
               updated_at AS updatedAt,
               completed_at AS completedAt
        FROM items
        WHERE list_id = $1
      `,
      [listId],
    );

    const rows = rowsResult.rows.map((item) => ({
      id: item.id,
      listId: item.listid,
      name: item.name,
      normalizedName: item.normalizedname,
      categoryKey: item.categorykey,
      categoryLabel: categoryLabels.get(item.categorykey) ?? "Other",
      status: item.status,
      createdAt: toIsoString(item.createdat)!,
      updatedAt: toIsoString(item.updatedat)!,
      completedAt: toIsoString(item.completedat),
    }));

    return {
      list,
      categories: DEFAULT_CATEGORIES,
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
