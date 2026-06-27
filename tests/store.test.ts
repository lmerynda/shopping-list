import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { AppStore, SESSION_TTL_MS } from "../server/store";

describe("AppStore", () => {
  let store: AppStore;
  let pool: { end: () => Promise<void> };

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const PgMemPool = adapter.Pool;
    pool = new PgMemPool();
    store = new AppStore({ db: pool as never });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await pool.end();
  });

  test("creates a default list on sign in", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const summaries = await store.getListSummaries(session!.session.user.id);

    expect(summaries).toMatchObject([
      {
        name: "Groceries",
        activeCount: 0,
        completedCount: 0,
        shared: false,
      },
    ]);
  });

  test("extends valid sessions when they are used", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const token = session!.token;
    const storedSession = store.sessions.get(token)!;
    storedSession.expiresAt = Date.now() + 1000;

    expect(store.getUserIdFromToken(token)).toBe(session!.session.user.id);
    expect(store.sessions.get(token)!.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 1000);
  });

  test("rejects and removes expired sessions", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const token = session!.token;
    store.sessions.get(token)!.expiresAt = Date.now() - 1;

    expect(store.getUserIdFromToken(token)).toBeNull();
    expect(store.sessions.has(token)).toBe(false);
  });

  test("adds items to a specific list", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const groceries = (await store.getListSummaries(session!.session.user.id))[0];
    const hardwareId = await store.createList(session!.session.user.id, "Hardware");

    await store.addListItem(session!.session.user.id, hardwareId, "Trash bags");

    const groceriesState = await store.getListState(session!.session.user.id, groceries.id);
    const hardwareState = await store.getListState(session!.session.user.id, hardwareId);
    expect(groceriesState.activeItems).toHaveLength(0);
    expect(hardwareState.activeItems[0]?.name).toBe("Trash bags");
  });

  test("lets owners delete lists", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const groceries = (await store.getListSummaries(session!.session.user.id))[0];

    await store.deleteList(session!.session.user.id, groceries.id);
    const nextCode = await store.requestMagicCode("owner@example.com", "Owner");
    await store.verifyMagicCode("owner@example.com", nextCode);

    expect(await store.getListSummaries(session!.session.user.id)).toHaveLength(0);
  });

  test("shares new lists with default share emails", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    await store.updateDefaultShareEmails(ownerSession!.session.user.id, ["wife@example.com"]);
    const sharedListId = await store.createList(ownerSession!.session.user.id, "Hardware");

    const memberCode = await store.requestMagicCode("wife@example.com", "Wife");
    const memberSession = await store.verifyMagicCode("wife@example.com", memberCode);
    const summaries = await store.getListSummaries(memberSession!.session.user.id);

    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sharedListId,
          name: "Hardware",
          shared: true,
          ownerName: "Owner",
        }),
      ]),
    );
  });

  test("records item history and returns merged suggestions", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const groceries = (await store.getListSummaries(ownerSession!.session.user.id))[0];

    await store.addListItem(ownerSession!.session.user.id, groceries.id, "Milk");
    await store.addListItem(ownerSession!.session.user.id, groceries.id, "Maple syrup");

    const suggestions = await store.getItemSuggestions(ownerSession!.session.user.id, groceries.id, "m");

    expect(suggestions.map((suggestion) => suggestion.name)).toContain("Milk");
    expect(suggestions.map((suggestion) => suggestion.name)).toContain("Maple syrup");

    const catalogSuggestions = await store.getItemSuggestions(ownerSession!.session.user.id, groceries.id, "br");
    expect(catalogSuggestions).toContainEqual({
      name: "Bread",
      normalizedName: "bread",
      source: "catalog",
    });
  });

  test("does not duplicate an already active list item", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const groceries = (await store.getListSummaries(ownerSession!.session.user.id))[0];

    await store.addListItem(ownerSession!.session.user.id, groceries.id, "Milk");
    await store.addListItem(ownerSession!.session.user.id, groceries.id, " milk ");

    const state = await store.getListState(ownerSession!.session.user.id, groceries.id);
    expect(state.activeItems).toHaveLength(1);
    expect(state.activeItems[0].name).toBe("Milk");
  });

  test("requires list access for suggestions", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const groceries = (await store.getListSummaries(ownerSession!.session.user.id))[0];

    const otherCode = await store.requestMagicCode("other@example.com", "Other");
    const otherSession = await store.verifyMagicCode("other@example.com", otherCode);

    await expect(store.getItemSuggestions(otherSession!.session.user.id, groceries.id, "")).rejects.toThrow(/forbidden/i);
  });

  test("default_shares repair migration creates the missing table", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const PgMemPool = adapter.Pool;
    const stalePool = new PgMemPool();

    try {
      await stalePool.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        )
      `);

      await stalePool.query(await readFile("server/migrations/002_create_default_shares.sql", "utf8"));

      await stalePool.query(
        "INSERT INTO users (email, display_name, created_at) VALUES ($1, $2, $3) RETURNING id",
        ["owner@example.com", "Owner", new Date().toISOString()],
      );
      await expect(
        stalePool.query("INSERT INTO default_shares (user_id, email, created_at) VALUES (1, $1, $2)", [
          "wife@example.com",
          new Date().toISOString(),
        ]),
      ).resolves.toBeDefined();
    } finally {
      await stalePool.end();
    }
  });
});
