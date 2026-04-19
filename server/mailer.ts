import nodemailer from "nodemailer";
import { config } from "./config.js";

type InviteEmailInput = {
  email: string;
  code: string;
  householdName: string;
};

const transporter = config.mail
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: {
        user: config.mail.user,
        pass: config.mail.pass,
      },
    })
  : null;

export function isMailEnabled() {
  return transporter !== null;
}

export async function sendInviteEmail(input: InviteEmailInput) {
  if (!transporter || !config.mail) {
    return false;
  }

  const inviteUrl = `${config.clientOrigin}?invite=${encodeURIComponent(input.code)}`;
  await transporter.sendMail({
    from: config.mail.from,
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
