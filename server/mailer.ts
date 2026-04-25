import { config } from "./config.js";

type LoginCodeEmailInput = {
  email: string;
  code: string;
};

type InviteEmailInput = {
  email: string;
  code: string;
  householdName: string;
};

type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export function isMailEnabled() {
  return config.mail !== null;
}

export async function sendLoginCodeEmail(input: LoginCodeEmailInput) {
  if (!config.mail) {
    return false;
  }

  await sendEmail({
    to: input.email,
    subject: "Your Shopping List sign-in code",
    text: [
      `Your Shopping List sign-in code is ${input.code}.`,
      "",
      "This code expires after your next sign-in request.",
      "If you did not request this code, you can ignore this email.",
    ].join("\n"),
    html: `
      <p>Your Shopping List sign-in code is <strong>${escapeHtml(input.code)}</strong>.</p>
      <p>This code expires after your next sign-in request.</p>
      <p>If you did not request this code, you can ignore this email.</p>
    `,
  });

  return true;
}

export async function sendInviteEmail(input: InviteEmailInput) {
  if (!config.mail) {
    return false;
  }

  const inviteUrl = `${config.clientOrigin}?invite=${encodeURIComponent(input.code)}`;
  await sendEmail({
    to: input.email,
    subject: `Join ${input.householdName} on Shopping List`,
    text: [
      `You were invited to join ${input.householdName} on Shopping List.`,
      "",
      `Invite code: ${input.code}`,
      `Open the app: ${inviteUrl}`,
      "",
      "If you already have an account, sign in and use the invite code.",
    ].join("\n"),
    html: `
      <p>You were invited to join <strong>${escapeHtml(input.householdName)}</strong> on Shopping List.</p>
      <p><strong>Invite code:</strong> ${escapeHtml(input.code)}</p>
      <p><a href="${escapeAttribute(inviteUrl)}">Open Shopping List</a></p>
      <p>If you already have an account, sign in and use the invite code.</p>
    `,
  });

  return true;
}

async function sendEmail(input: EmailInput) {
  if (!config.mail) {
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.mail.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.mail.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend email failed: ${response.status} ${await response.text()}`);
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
