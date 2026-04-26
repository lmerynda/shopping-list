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
  const sentAt = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date());
  await sendEmail({
    to: input.email,
    subject: `Join ${input.householdName} on Shopping List`,
    text: [
      `Open this invite link: ${inviteUrl}`,
      "",
      `You were invited to join ${input.householdName} on Shopping List.`,
      `Sent: ${sentAt}`,
      "",
      "If prompted, sign in with this email address to join automatically.",
      "",
      `Invite code: ${input.code}`,
    ].join("\n"),
    html: `
      <p><a href="${escapeAttribute(inviteUrl)}">Open Shopping List</a></p>
      <p>${escapeHtml(inviteUrl)}</p>
      <p>You were invited to join <strong>${escapeHtml(input.householdName)}</strong> on Shopping List.</p>
      <p>Sent: ${escapeHtml(sentAt)}</p>
      <p>If prompted, sign in with this email address to join automatically.</p>
      <p><strong>Invite code:</strong> ${escapeHtml(input.code)}</p>
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
