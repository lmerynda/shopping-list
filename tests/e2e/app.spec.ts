import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, name: string) {
  await page.goto("/");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send magic code" }).click();
  const codeText = await page.getByTestId("dev-auth-code").textContent();
  const code = codeText?.split(":").at(-1)?.trim();
  if (!code) throw new Error("Expected dev auth code");
  await page.getByLabel("Verification code").fill(code);
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

  await owner.getByRole("button", { name: "Settings" }).click();
  await owner.getByLabel("Default share email").fill("wife@example.com");
  await owner.getByRole("button", { name: "Add email" }).click();
  await expect(owner.getByText("wife@example.com")).toBeVisible();
  await owner.getByRole("button", { name: "Back" }).click();

  await owner.getByPlaceholder("Groceries").fill("Weekend");
  await owner.getByRole("button", { name: "Create list" }).click();
  await expect(owner.getByRole("button", { name: /Weekend/ })).toBeVisible();
  await owner.getByRole("button", { name: /Weekend/ }).click();
  await expect(owner.getByRole("heading", { name: "Weekend" })).toBeVisible();

  await owner.getByPlaceholder("Milk").fill("Milk");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").getByText("Milk")).toBeVisible();
  const rowBox = await owner.locator(".list-panel .item-row").first().boundingBox();
  expect(rowBox?.height).toBeLessThanOrEqual(48);

  await signIn(member, "wife@example.com", "Wife");
  await expect(member.getByRole("button", { name: /Weekend/ })).toBeVisible();
  await member.getByRole("button", { name: /Weekend/ }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await member.locator(".list-panel").getByRole("button", { name: "Mark bought" }).click();
  await expect(member.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: "Back" }).click();
  await owner.getByRole("button", { name: /Weekend/ }).click();
  await expect(owner.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: /Bought/ }).click();
  await expect(owner.getByText("Milk")).toBeVisible();

  await owner.getByRole("button", { name: "Re-add" }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await owner.getByPlaceholder("Milk").fill("Mi");
  await expect(owner.getByRole("button", { name: "Milk" })).toBeVisible();
  await owner.getByRole("button", { name: "Milk" }).click();
  await expect(owner.locator(".list-panel .item-row")).toHaveCount(1);
  await owner.getByPlaceholder("Milk").fill("Bread");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").getByText("Bread")).toBeVisible();
});
