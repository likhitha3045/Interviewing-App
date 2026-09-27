import nodemailer from 'nodemailer';

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT ?? 587);
const transporter = smtpHost ? nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;
const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'Interviewly <no-reply@localhost>';
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const serverOrigin = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

export async function sendEmail(to: string, subject: string, text: string, actionUrl?: string): Promise<boolean> {
  const safeText = escapeHtml(text).replace(/\n/g, '<br>');
  const action = actionUrl ? `<p><a href="${escapeHtml(actionUrl)}" style="background:#7865e8;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Continue to Interviewly</a></p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#29283b"><h2>Interviewly</h2><p>${safeText}</p>${action}<p style="color:#888;font-size:12px">If you did not expect this message, you can ignore it.</p></div>`;
  if (!transporter) {
    if (process.env.NODE_ENV === 'production') throw new Error('SMTP_HOST must be configured to send email in production.');
    console.info(`[mail:development-only] To: ${to} | Subject: ${subject}${actionUrl ? ` | Link: ${actionUrl}` : ''}`);
    return false;
  }
  await transporter.sendMail({ from, to, subject, text, html });
  return true;
}

export const isEmailConfigured = () => Boolean(transporter);

export const clientUrl = (path: string) => new URL(path, clientOrigin).toString();
export const serverUrl = (path: string) => new URL(path, serverOrigin).toString();
