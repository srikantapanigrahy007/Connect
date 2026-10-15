import { APP_NAME } from '#shared';
import nodemailer from 'nodemailer';

/**
 * @typedef {object} EmailMessage
 * @property {string} to
 * @property {string} subject
 * @property {string} text Plain-text body.
 * @property {string} html HTML body.
 */

/**
 * Anything that can send an email. Production uses SMTP; development and tests use the
 * log and memory mailers below.
 *
 * @typedef {object} Mailer
 * @property {(message: EmailMessage) => Promise<void>} send
 */

/** Any SMTP server works: a self-hosted MTA, your provider's SMTP relay, or Mailpit locally. */
export function createSmtpMailer(settings) {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
  });
  return {
    async send(message) {
      await transport.sendMail({ from: settings.from, ...message });
    },
  };
}

/** Development fallback without SMTP: writes emails (including links) to the log. Never used in production. */
export function createLogMailer(logger) {
  return {
    send(message) {
      logger.info(`[dev email] to=${message.to} subject="${message.subject}"\n${message.text}`);
      return Promise.resolve();
    },
  };
}

/** Test mailer that records messages. */
export function createMemoryMailer() {
  const outbox = [];
  return {
    outbox,
    send(message) {
      outbox.push(message);
      return Promise.resolve();
    },
  };
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function linkEmail(to, subject, intro, linkLabel, url, outro) {
  return {
    to,
    subject,
    text: `${intro}\n\n${linkLabel}: ${url}\n\n${outro}`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p><p>${escapeHtml(outro)}</p>`,
  };
}

export const emails = {
  verifyEmail: (to, url) =>
    linkEmail(
      to,
      `Verify your ${APP_NAME} email address`,
      `Welcome to ${APP_NAME}! Confirm this email address to finish setting up your account.`,
      'Verify email address',
      url,
      "This link expires in 24 hours. If you didn't create an account, you can ignore this email.",
    ),
  resetPassword: (to, url) =>
    linkEmail(
      to,
      `Reset your ${APP_NAME} password`,
      'Someone asked to reset the password for this account.',
      'Choose a new password',
      url,
      "This link expires in 30 minutes and can be used once. If it wasn't you, you can ignore this email; your password hasn't changed.",
    ),
  passwordChanged: (to) => ({
    to,
    subject: `Your ${APP_NAME} password was changed`,
    text: `The password for your ${APP_NAME} account was just changed and every device was signed out. If this wasn't you, reset your password immediately.`,
    html: `<p>The password for your ${APP_NAME} account was just changed and every device was signed out.</p><p>If this wasn't you, reset your password immediately.</p>`,
  }),
};
