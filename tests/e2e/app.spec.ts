import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, name: string, path = "/") {
  await page.goto(path);
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

test("shared household flow works end to end", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  await signIn(owner, "owner@example.com", "Owner");
  await owner.getByLabel("New household").fill("Smith Home");
  await owner.getByRole("button", { name: "Create household" }).click();
  await expect(owner.getByRole("button", { name: /Groceries/ })).toBeVisible();
  await owner.getByRole("button", { name: /Groceries/ }).click();
  await expect(owner.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await owner.getByPlaceholder("Milk").fill("Milk");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").getByText("Milk")).toBeVisible();

  await owner.getByRole("button", { name: "Settings" }).click();
  await owner.getByPlaceholder("family@example.com").fill("wife@example.com");
  await owner.getByRole("button", { name: "Send invite" }).click();
  const inviteCodeText = await owner.getByTestId("dev-invite-code").textContent();
  const inviteCode = inviteCodeText?.split(":").at(-1)?.trim();
  if (!inviteCode) throw new Error("Expected invite code");

  await signIn(member, "wife@example.com", "Wife", `/?invite=${inviteCode}`);
  await expect(member.getByRole("button", { name: /Groceries/ })).toBeVisible();
  await member.getByRole("button", { name: /Groceries/ }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await member.locator(".list-panel").getByRole("button", { name: "Mark bought" }).click();
  await expect(member.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: "Back" }).click();
  await owner.getByRole("button", { name: /Groceries/ }).click();
  await expect(owner.locator(".list-panel").getByText("Nothing here yet.")).toBeVisible();
  await owner.getByRole("button", { name: /Bought/ }).click();
  await expect(owner.getByText("Milk")).toBeVisible();

  await owner.getByRole("button", { name: "Re-add" }).click();
  await expect(member.locator(".list-panel").getByText("Milk")).toBeVisible();

  await owner.locator(".list-panel").getByRole("combobox").selectOption("pharmacy");
  await owner.getByPlaceholder("Milk").fill("Milk");
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.locator(".list-panel").locator(".category-pill").filter({ hasText: "Pharmacy" })).toBeVisible();
});
