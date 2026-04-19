import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CATEGORIES, inferDefaultCategory, normalizeItemName, sortCategories } from "../src/lib/categories.js";
import type { HouseholdState, SessionPayload } from "../src/lib/types.js";

type Session = {
  token: string;
  userId: number;
};

function now(): string {
  return new Date().toISOString();
}

function createCode(length = 8): string {
  return randomBytes(length).toString("hex").slice(0, length).toUpperCase();
}

export class AppStore {
  db: Database.Database;
  sessions = new Map<string, Session>();

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS magic_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS households (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS household_memberships (
        user_id INTEGER NOT NULL,
        household_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, household_id)
      );

      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS household_categories (
        household_id INTEGER NOT NULL,
        category_key TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (household_id, category_key)
      );

      CREATE TABLE IF NOT EXISTS category_rules (
        household_id INTEGER NOT NULL,
        normalized_name TEXT NOT NULL,
        category_key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (household_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        note TEXT,
        category_key TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  }

  resetForTests() {
    this.db.exec(`
      DELETE FROM category_rules;
      DELETE FROM household_categories;
      DELETE FROM invites;
      DELETE FROM household_memberships;
      DELETE FROM items;
      DELETE FROM households;
      DELETE FROM magic_codes;
      DELETE FROM users;
    `);
    this.sessions.clear();
  }

  requestMagicCode(email: string, displayName?: string) {
    const existingUser = this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email) as { id: number } | undefined;
    if (!existingUser && displayName) {
      this.db
        .prepare("INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)")
        .run(email, displayName.trim(), now());
    }

    const code = createCode(6);
    this.db.prepare("INSERT INTO magic_codes (email, code, created_at) VALUES (?, ?, ?)").run(email, code, now());
    return code;
  }

  verifyMagicCode(email: string, code: string): { token: string; session: SessionPayload } | null {
    const latest = this.db
      .prepare("SELECT code FROM magic_codes WHERE email = ? ORDER BY id DESC LIMIT 1")
      .get(email) as { code: string } | undefined;

    if (!latest || latest.code !== code) {
      return null;
    }

    let user = this.db
      .prepare("SELECT id, email, display_name as displayName FROM users WHERE email = ?")
      .get(email) as { id: number; email: string; displayName: string } | undefined;

    if (!user) {
      const name = email.split("@")[0];
      const result = this.db
        .prepare("INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)")
        .run(email, name, now());
      user = { id: Number(result.lastInsertRowid), email, displayName: name };
    }

    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { token, userId: user.id });

    return {
      token,
      session: this.getSessionPayload(user.id),
    };
  }

  getUserIdFromToken(token: string | undefined): number | null {
    if (!token) {
      return null;
    }
    return this.sessions.get(token)?.userId ?? null;
  }

  getSessionPayload(userId: number): SessionPayload {
    const user = this.db
      .prepare("SELECT id, email, display_name as displayName FROM users WHERE id = ?")
      .get(userId) as SessionPayload["user"];
    const households = this.db
      .prepare(
        `
          SELECT households.id, households.name, household_memberships.role
          FROM households
          JOIN household_memberships ON household_memberships.household_id = households.id
          WHERE household_memberships.user_id = ?
          ORDER BY households.name
        `,
      )
      .all(userId) as SessionPayload["households"];
    return { user, households };
  }

  createHousehold(userId: number, name: string) {
    const createdAt = now();
    const result = this.db.prepare("INSERT INTO households (name, created_at) VALUES (?, ?)").run(name, createdAt);
    const householdId = Number(result.lastInsertRowid);
    this.db
      .prepare(
        "INSERT INTO household_memberships (user_id, household_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .run(userId, householdId, createdAt);

    for (const category of DEFAULT_CATEGORIES) {
      this.db
        .prepare(
          "INSERT INTO household_categories (household_id, category_key, label, sort_order) VALUES (?, ?, ?, ?)",
        )
        .run(householdId, category.key, category.label, category.sortOrder);
    }

    return this.getSessionPayload(userId);
  }

  ensureMembership(userId: number, householdId: number) {
    const membership = this.db
      .prepare("SELECT role FROM household_memberships WHERE user_id = ? AND household_id = ?")
      .get(userId, householdId) as { role: "owner" | "member" } | undefined;

    if (!membership) {
      throw new Error("Forbidden");
    }

    return membership;
  }

  createInvite(userId: number, householdId: number, email: string) {
    this.ensureMembership(userId, householdId);
    const code = createCode(10);
    this.db
      .prepare("INSERT INTO invites (household_id, email, code, created_at) VALUES (?, ?, ?, ?)")
      .run(householdId, email, code, now());
    return code;
  }

  acceptInvite(userId: number, code: string) {
    const invite = this.db
      .prepare("SELECT id, household_id as householdId, email, accepted_at as acceptedAt FROM invites WHERE code = ?")
      .get(code) as { id: number; householdId: number; email: string; acceptedAt: string | null } | undefined;
    if (!invite || invite.acceptedAt) {
      throw new Error("Invite not found");
    }

    const user = this.db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string };
    if (user.email !== invite.email) {
      throw new Error("Invite email does not match the current account");
    }

    const createdAt = now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO household_memberships (user_id, household_id, role, created_at) VALUES (?, ?, 'member', ?)",
      )
      .run(userId, invite.householdId, createdAt);
    this.db.prepare("UPDATE invites SET accepted_at = ? WHERE id = ?").run(createdAt, invite.id);

    return this.getSessionPayload(userId);
  }

  resolveCategory(householdId: number, name: string) {
    const normalized = normalizeItemName(name);
    const learned = this.db
      .prepare("SELECT category_key as categoryKey FROM category_rules WHERE household_id = ? AND normalized_name = ?")
      .get(householdId, normalized) as { categoryKey: string } | undefined;
    return learned?.categoryKey ?? inferDefaultCategory(name);
  }

  addItem(userId: number, householdId: number, name: string, note?: string) {
    this.ensureMembership(userId, householdId);
    const timestamp = now();
    const normalized = normalizeItemName(name);
    const categoryKey = this.resolveCategory(householdId, name);
    const result = this.db
      .prepare(
        `
          INSERT INTO items (household_id, name, normalized_name, note, category_key, status, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)
        `,
      )
      .run(householdId, name.trim(), normalized, note?.trim() || null, categoryKey, timestamp, timestamp);
    return Number(result.lastInsertRowid);
  }

  updateItem(userId: number, itemId: number, patch: { name?: string; note?: string | null; categoryKey?: string; status?: "active" | "completed" }) {
    const item = this.db
      .prepare("SELECT id, household_id as householdId, name, note, status, completed_at as completedAt FROM items WHERE id = ?")
      .get(itemId) as
      | { id: number; householdId: number; name: string; note: string | null; status: "active" | "completed"; completedAt: string | null }
      | undefined;
    if (!item) {
      throw new Error("Item not found");
    }
    this.ensureMembership(userId, item.householdId);

    const nextName = patch.name?.trim() || item.name;
    const nextNormalized = normalizeItemName(nextName);
    const nextCategory = patch.categoryKey ?? this.resolveCategory(item.householdId, nextName);
    const nextStatus = patch.status ?? item.status;
    const completedAt = nextStatus === "completed" ? item.completedAt ?? now() : null;
    const note = patch.note === undefined ? item.note : patch.note?.trim() || null;

    this.db
      .prepare(
        `
          UPDATE items
          SET name = ?,
              normalized_name = ?,
              note = ?,
              category_key = ?,
              status = ?,
              updated_at = ?,
              completed_at = ?
          WHERE id = ?
        `,
      )
      .run(nextName, nextNormalized, note, nextCategory, nextStatus, now(), completedAt, itemId);

    if (patch.categoryKey) {
      this.db
        .prepare(
          "INSERT INTO category_rules (household_id, normalized_name, category_key, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(household_id, normalized_name) DO UPDATE SET category_key = excluded.category_key, updated_at = excluded.updated_at",
        )
        .run(item.householdId, nextNormalized, patch.categoryKey, now());
    }
  }

  getHouseholdState(userId: number, householdId: number): HouseholdState {
    const membership = this.ensureMembership(userId, householdId);
    const household = this.db
      .prepare("SELECT id, name FROM households WHERE id = ?")
      .get(householdId) as { id: number; name: string };
    const categories = this.db
      .prepare(
        "SELECT category_key as key, label, sort_order as sortOrder FROM household_categories WHERE household_id = ? ORDER BY sort_order",
      )
      .all(householdId) as HouseholdState["categories"];
    const categoryMap = new Map(categories.map((category) => [category.key, category.sortOrder]));
    const rows = this.db
      .prepare(
        `
          SELECT items.id, items.household_id as householdId, items.name, items.normalized_name as normalizedName,
                 items.note, items.category_key as categoryKey, household_categories.label as categoryLabel,
                 items.status, items.created_at as createdAt, items.updated_at as updatedAt, items.completed_at as completedAt
          FROM items
          JOIN household_categories
            ON household_categories.household_id = items.household_id
           AND household_categories.category_key = items.category_key
          WHERE items.household_id = ?
        `,
      )
      .all(householdId) as HouseholdState["activeItems"];
    const invites = this.db
      .prepare(
        "SELECT id, email, code, created_at as createdAt, accepted_at as acceptedAt FROM invites WHERE household_id = ? ORDER BY created_at DESC",
      )
      .all(householdId) as HouseholdState["invites"];

    const activeItems = sortCategories(
      rows.filter((item) => item.status === "active"),
      categoryMap,
    );
    const completedItems = sortCategories(
      rows.filter((item) => item.status === "completed"),
      categoryMap,
    );

    return {
      household: { ...household, role: membership.role },
      categories,
      activeItems,
      completedItems,
      invites,
    };
  }
}
