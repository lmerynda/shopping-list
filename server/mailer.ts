import { config } from "./config.js";

type LoginCodeEmailInput = {
  email: string;
  code: string;
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
