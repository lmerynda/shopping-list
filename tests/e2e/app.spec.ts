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

test("shared household flow works end to end", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  await signIn(owner, "owner@example.com", "Owner");
  await owner.getByLabel("New household").fill("Smith Home");
  await owner.getByRole("button", { name: "Create" }).click();
  await expect(owner.getByRole("heading", { name: "Smith Home" })).toBeVisible();

  await owner.getByPlaceholder("Milk").fill("Milk");
  await owner.getByRole("button", { name: "Add" }).click();
  await expect(owner.locator(".panel").nth(1).getByText("Milk")).toBeVisible();

  await owner.getByPlaceholder("family@example.com").fill("wife@example.com");
  await owner.getByRole("button", { name: "Send invite" }).click();
  const inviteCodeText = await owner.getByTestId("dev-invite-code").textContent();
  const inviteCode = inviteCodeText?.split(":").at(-1)?.trim();
  if (!inviteCode) throw new Error("Expected invite code");

  await signIn(member, "wife@example.com", "Wife");
  await member.getByLabel("Invite code").fill(inviteCode);
  await member.getByRole("button", { name: "Join" }).click();
  await expect(member.getByRole("heading", { name: "Smith Home" })).toBeVisible();
  await expect(member.locator(".panel").nth(1).getByText("Milk")).toBeVisible();

  await member.locator(".panel").nth(1).getByRole("button", { name: "Mark bought" }).click();
  await expect(member.locator(".panel").nth(1).getByText("Nothing here yet.")).toBeVisible();
  await expect(owner.locator(".panel").nth(1).getByText("Nothing here yet.")).toBeVisible();
  await expect(owner.locator(".panel").nth(2).getByText("Milk")).toBeVisible();

  await owner.locator(".panel").nth(2).getByRole("button", { name: "Re-add" }).click();
  await expect(member.locator(".panel").nth(1).getByText("Milk")).toBeVisible();

  await owner.locator(".panel").nth(1).getByRole("combobox").selectOption("pharmacy");
  await owner.getByPlaceholder("Milk").fill("Milk");
  await owner.getByRole("button", { name: "Add" }).click();
  await expect(owner.locator(".panel").nth(1).locator(".item-row p").filter({ hasText: "Pharmacy" })).toBeVisible();
});
