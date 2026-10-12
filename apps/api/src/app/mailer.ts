import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'],
  port: Number(process.env['SMTP_PORT'] ?? 587),
  secure: process.env['SMTP_SECURE'] === 'true',
  auth: {
    user: process.env['SMTP_USER'],
    pass: process.env['SMTP_PASS'],
  },
});

const htmlEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

// Never throws: mail is best effort and callers fire and forget it.
export async function sendMail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!process.env['SMTP_HOST']) {
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? process.env['SMTP_USER'],
      to,
      subject,
      html,
    });

    return true;
  } catch (e) {
    console.error('Error sending mail', e);

    return false;
  }
}

export function sendMentionNotificationEmail(
  to: string,
  boardId: string,
  boardName: string,
  mentionedBy: string,
  nodeId?: string,
) {
  let boardUrl = `${process.env['FRONTEND_URL']}/board/${encodeURIComponent(boardId)}`;
  if (nodeId) {
    boardUrl += `?nodeId=${encodeURIComponent(nodeId)}`;
  }
  const subject = `Tapiz - You were mentioned on ${boardName}`;
  const text = `${escapeHtml(mentionedBy)} mentioned you on the board <a href="${escapeHtml(boardUrl)}">${escapeHtml(boardName)}</a>.`;

  return sendMail(to, subject, text);
}

export function sendInvitationEmail(
  to: string,
  teamName: string,
  inviterName: string,
) {
  const subject = `Tapiz - You were invited to join ${teamName}`;
  const text = `${escapeHtml(inviterName)} invited you to join the team ${escapeHtml(teamName)}. Check your invites in <a href="${escapeHtml(process.env['FRONTEND_URL'] ?? '')}">Tapiz</a>.`;

  return sendMail(to, subject, text);
}
