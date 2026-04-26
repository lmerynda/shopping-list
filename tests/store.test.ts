import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { newDb } from "pg-mem";
import { AppStore } from "../server/store";

describe("AppStore", () => {
  let store: AppStore;
  let pool: { end: () => Promise<void> };

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    // pg-mem exposes a pg-compatible Pool constructor.
    const PgMemPool = adapter.Pool;
    pool = new PgMemPool();
    store = new AppStore({ db: pool as never });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await pool.end();
  });

  test("creates households and grants membership", async () => {
    const code = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", code);
    const next = await store.createHousehold(session!.session.user.id, "Home");

    expect(next.households).toHaveLength(1);
    expect(next.households[0].name).toBe("Home");
  });

  test("learns category corrections for future items", async () => {
    const firstCode = await store.requestMagicCode("owner@example.com", "Owner");
    const session = await store.verifyMagicCode("owner@example.com", firstCode);
    const household = (await store.createHousehold(session!.session.user.id, "Home")).households[0];

    const firstItemId = await store.addItem(session!.session.user.id, household.id, "Soap refill");
    await store.updateItem(session!.session.user.id, firstItemId, { categoryKey: "pharmacy" });
    const nextItemId = await store.addItem(session!.session.user.id, household.id, "Soap refill");
    const state = await store.getHouseholdState(session!.session.user.id, household.id);
    const nextItem = state.activeItems.find((item) => item.id === nextItemId);

    expect(nextItem?.categoryKey).toBe("pharmacy");
  });

  test("requires invite email to match current user", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const household = (await store.createHousehold(ownerSession!.session.user.id, "Home")).households[0];
    const inviteCode = await store.createInvite(ownerSession!.session.user.id, household.id, "wife@example.com");

    const otherCode = await store.requestMagicCode("other@example.com", "Other");
    const otherSession = await store.verifyMagicCode("other@example.com", otherCode);

    await expect(store.acceptInvite(otherSession!.session.user.id, inviteCode)).rejects.toThrow(/email does not match/i);
  });

  test("removes pending invites", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const household = (await store.createHousehold(ownerSession!.session.user.id, "Home")).households[0];
    await store.createInvite(ownerSession!.session.user.id, household.id, "wife@example.com");

    const withInvite = await store.getHouseholdState(ownerSession!.session.user.id, household.id);
    expect(withInvite.invites).toHaveLength(1);

    await store.deletePendingInvite(ownerSession!.session.user.id, withInvite.invites[0].id);

    const withoutInvite = await store.getHouseholdState(ownerSession!.session.user.id, household.id);
    expect(withoutInvite.invites).toHaveLength(0);
  });

  test("returns pending invite preview", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const household = (await store.createHousehold(ownerSession!.session.user.id, "Home")).households[0];
    const inviteCode = await store.createInvite(ownerSession!.session.user.id, household.id, "wife@example.com");

    await expect(store.getInvitePreview(inviteCode)).resolves.toEqual({
      email: "wife@example.com",
      householdName: "Home",
    });
  });

  test("keeps completed items completed when only category changes", async () => {
    const ownerCode = await store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = await store.verifyMagicCode("owner@example.com", ownerCode);
    const household = (await store.createHousehold(ownerSession!.session.user.id, "Home")).households[0];
    const itemId = await store.addItem(ownerSession!.session.user.id, household.id, "Milk");

    await store.updateItem(ownerSession!.session.user.id, itemId, { status: "completed" });
    await store.updateItem(ownerSession!.session.user.id, itemId, { categoryKey: "pharmacy" });

    const state = await store.getHouseholdState(ownerSession!.session.user.id, household.id);
    expect(state.activeItems).toHaveLength(0);
    expect(state.completedItems[0]?.categoryKey).toBe("pharmacy");
  });
});
