import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { DEFAULT_CATEGORIES, inferDefaultCategory, normalizeItemName, sortCategories } from "../src/lib/categories.js";
import type { HouseholdState, SessionPayload } from "../src/lib/types.js";
import { runMigrations } from "./migrate.js";

type Session = {
  token: string;
  userId: number;
};

type Queryable = {
  query<Result = unknown>(text: string, values?: unknown[]): Promise<{ rows: Result[]; rowCount: number | null }>;
  end?: () => Promise<void>;
};

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
  householdid: number;
  name: string;
  note: string | null;
  status: "active" | "completed";
  completedat: string | null;
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
      "TRUNCATE TABLE category_rules, household_categories, invites, household_memberships, items, households, magic_codes, users RESTART IDENTITY CASCADE",
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
    this.sessions.set(token, { token, userId: user.id });

    return {
      token,
      session: await this.getSessionPayload(user.id),
    };
  }

  getUserIdFromToken(token: string | undefined): number | null {
    if (!token) {
      return null;
    }
    return this.sessions.get(token)?.userId ?? null;
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

  async resolveCategory(householdId: number, name: string) {
    const normalized = normalizeItemName(name);
    const learned = await this.db.query<{ categorykey: string }>(
      "SELECT category_key AS categoryKey FROM category_rules WHERE household_id = $1 AND normalized_name = $2",
      [householdId, normalized],
    );
    return learned.rows[0]?.categorykey ?? inferDefaultCategory(name);
  }

  async addItem(userId: number, householdId: number, name: string, note?: string) {
    await this.ensureMembership(userId, householdId);
    const timestamp = now();
    const normalized = normalizeItemName(name);
    const categoryKey = await this.resolveCategory(householdId, name);
    const result = await this.db.query<{ id: number }>(
      `
        INSERT INTO items (household_id, name, normalized_name, note, category_key, status, created_at, updated_at, completed_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, NULL)
        RETURNING id
      `,
      [householdId, name.trim(), normalized, note?.trim() || null, categoryKey, timestamp, timestamp],
    );
    return result.rows[0].id;
  }

  async updateItem(
    userId: number,
    itemId: number,
    patch: { name?: string; note?: string | null; categoryKey?: string; status?: "active" | "completed" },
  ) {
    const itemResult = await this.db.query<ItemRecord>(
      "SELECT id, household_id AS householdId, name, note, status, completed_at AS completedAt FROM items WHERE id = $1",
      [itemId],
    );
    const item = itemResult.rows[0];
    if (!item) {
      throw new Error("Item not found");
    }
    await this.ensureMembership(userId, item.householdid);

    const nextName = patch.name?.trim() || item.name;
    const nextNormalized = normalizeItemName(nextName);
    const nextCategory = patch.categoryKey ?? (await this.resolveCategory(item.householdid, nextName));
    const nextStatus = patch.status ?? item.status;
    const completedAt = nextStatus === "completed" ? item.completedat ?? now() : null;
    const note = patch.note === undefined ? item.note : patch.note?.trim() || null;

    await this.db.query(
      `
        UPDATE items
        SET name = $1,
            normalized_name = $2,
            note = $3,
            category_key = $4,
            status = $5,
            updated_at = $6,
            completed_at = $7
        WHERE id = $8
      `,
      [nextName, nextNormalized, note, nextCategory, nextStatus, now(), completedAt, itemId],
    );

    if (patch.categoryKey) {
      await this.db.query(
        `
          INSERT INTO category_rules (household_id, normalized_name, category_key, updated_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (household_id, normalized_name)
          DO UPDATE SET category_key = EXCLUDED.category_key, updated_at = EXCLUDED.updated_at
        `,
        [item.householdid, nextNormalized, patch.categoryKey, now()],
      );
    }
  }

  async getItemHouseholdId(itemId: number) {
    const result = await this.db.query<{ householdid: number }>(
      "SELECT household_id AS householdId FROM items WHERE id = $1",
      [itemId],
    );
    return result.rows[0]?.householdid ?? null;
  }

  async getHousehold(userId: number, householdId: number) {
    await this.ensureMembership(userId, householdId);
    const result = await this.db.query<{ id: number; name: string }>(
      "SELECT id, name FROM households WHERE id = $1",
      [householdId],
    );
    return result.rows[0] ?? null;
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
      householdid: number;
      name: string;
      normalizedname: string;
      note: string | null;
      categorykey: string;
      categorylabel: string;
      status: "active" | "completed";
      createdat: string;
      updatedat: string;
      completedat: string | null;
    }>(
      `
        SELECT items.id,
               items.household_id AS householdId,
               items.name,
               items.normalized_name AS normalizedName,
               items.note,
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
      householdId: item.householdid,
      name: item.name,
      normalizedName: item.normalizedname,
      note: item.note,
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
}
