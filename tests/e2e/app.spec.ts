import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, name: string) {
  // Use direct dev login for localhost (no magic code flow) then inject session.
  // Falls back to UI if needed.
  const loginRes = await page.request.post("http://127.0.0.1:4000/api/test/login", {
    data: { email, displayName: name },
  });
  if (loginRes.ok()) {
    const { token } = await loginRes.json();
    await page.goto("/");
    await page.evaluate((t) => {
      localStorage.setItem("shopping-list-session-token", t);
    }, token);
    // Reload so the app picks up the token from storage
    await page.reload();
    return;
  }

  // Fallback to the (now very simple) UI flow on localhost
  await page.goto("/");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:4000/api/test/reset");
});

test("default sharing flow works end to end", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  await signIn(owner, "owner@example.com", "Owner");
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await owner.getByRole("button", { name: "More options" }).click();
  await owner.getByRole("menuitem", { name: "Settings" }).click();
  await owner.getByLabel("Default share email").fill("wife@example.com");
  await owner.getByRole("button", { name: "Add email" }).click();
  await expect(owner.getByText("wife@example.com")).toBeVisible();
  await owner.getByRole("button", { name: "Back" }).click();

  await owner.getByRole("button", { name: "New list" }).click();
  await owner.getByPlaceholder("Groceries").fill("Weekend");
  await owner.getByRole("button", { name: "Create list" }).click();
  await expect(owner.getByRole("button", { name: /Weekend/ })).toBeVisible();
  await owner.getByRole("button", { name: /Weekend/ }).click();
  await expect(owner.getByRole("heading", { name: "Weekend" })).toBeVisible();

  await owner.getByPlaceholder("Add item").fill("Milk");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").getByText("Milk")).toBeVisible();
  const rowBox = await owner.locator(".list-panel .item-row").first().boundingBox();
  expect(rowBox?.height).toBeLessThanOrEqual(64);

  await signIn(member, "wife@example.com", "Wife");
  await expect(member.getByRole("button", { name: /Weekend/ })).toBeVisible();
  await member.getByRole("button", { name: /Weekend/ }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await member.locator(".list-panel").getByRole("button", { name: "Mark bought" }).click();
  await expect(member.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: "Back" }).click();
  await owner.getByRole("button", { name: /Weekend/ }).click();
  await expect(owner.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: /Checked/ }).click();
  await expect(owner.getByText("Milk")).toBeVisible();

  await owner.getByRole("button", { name: "Re-add" }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await owner.getByPlaceholder("Add item").fill("Mi");
  await expect(owner.getByRole("button", { name: "Milk" })).toBeVisible();
  await owner.getByRole("button", { name: "Milk" }).click();
  await expect(owner.locator(".list-panel .item-row")).toHaveCount(1);
  await owner.getByPlaceholder("Add item").fill("Bread");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").getByText("Bread")).toBeVisible();
});

test("list deletion requires confirmation", async ({ page }) => {
  await signIn(page, "owner@example.com", "Owner");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Delete list" }).click();
  await expect(page.getByRole("dialog", { name: /Delete “Groceries”/ })).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Delete list" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No lists yet")).toBeVisible();
});

test("mobile screens fit the viewport and controls are touch friendly", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page, "mobile@example.com", "Mobile");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

  const addButton = page.getByRole("button", { name: "Add item" });
  const box = await addButton.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(42);
  expect(box?.height).toBeGreaterThanOrEqual(42);
});
