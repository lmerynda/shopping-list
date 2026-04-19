import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppStore } from "../server/store";

describe("AppStore", () => {
  let store: AppStore;

  beforeEach(() => {
    store = new AppStore(":memory:");
  });

  afterEach(() => {
    store.db.close();
  });

  test("creates households and grants membership", () => {
    store.requestMagicCode("owner@example.com", "Owner");
    const session = store.verifyMagicCode("owner@example.com", store.requestMagicCode("owner@example.com"))!;
    const next = store.createHousehold(session.session.user.id, "Home");

    expect(next.households).toHaveLength(1);
    expect(next.households[0].name).toBe("Home");
  });

  test("learns category corrections for future items", () => {
    const firstCode = store.requestMagicCode("owner@example.com", "Owner");
    const session = store.verifyMagicCode("owner@example.com", firstCode)!;
    const household = store.createHousehold(session.session.user.id, "Home").households[0];

    const firstItemId = store.addItem(session.session.user.id, household.id, "Soap refill");
    store.updateItem(session.session.user.id, firstItemId, { categoryKey: "pharmacy" });
    const nextItemId = store.addItem(session.session.user.id, household.id, "Soap refill");
    const state = store.getHouseholdState(session.session.user.id, household.id);
    const nextItem = state.activeItems.find((item) => item.id === nextItemId);

    expect(nextItem?.categoryKey).toBe("pharmacy");
  });

  test("requires invite email to match current user", () => {
    const ownerCode = store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = store.verifyMagicCode("owner@example.com", ownerCode)!;
    const household = store.createHousehold(ownerSession.session.user.id, "Home").households[0];
    const inviteCode = store.createInvite(ownerSession.session.user.id, household.id, "wife@example.com");

    const otherCode = store.requestMagicCode("other@example.com", "Other");
    const otherSession = store.verifyMagicCode("other@example.com", otherCode)!;

    expect(() => store.acceptInvite(otherSession.session.user.id, inviteCode)).toThrow(/email does not match/i);
  });

  test("keeps completed items completed when only category changes", () => {
    const ownerCode = store.requestMagicCode("owner@example.com", "Owner");
    const ownerSession = store.verifyMagicCode("owner@example.com", ownerCode)!;
    const household = store.createHousehold(ownerSession.session.user.id, "Home").households[0];
    const itemId = store.addItem(ownerSession.session.user.id, household.id, "Milk");

    store.updateItem(ownerSession.session.user.id, itemId, { status: "completed" });
    store.updateItem(ownerSession.session.user.id, itemId, { categoryKey: "pharmacy" });

    const state = store.getHouseholdState(ownerSession.session.user.id, household.id);
    expect(state.activeItems).toHaveLength(0);
    expect(state.completedItems[0]?.categoryKey).toBe("pharmacy");
  });
});
