import { isEmail } from 'class-validator';
import type { SendMailOptions } from 'nodemailer';

type VoucherEmail = SendMailOptions & { text: string; html: string };

function formatRecipients(recipients: SendMailOptions['to']): string {
  const list = Array.isArray(recipients) ? recipients : recipients ? [recipients] : [];
  return list.map((recipient) => typeof recipient === 'string' ? recipient : recipient.address)
    .filter(Boolean).join(', ') || 'None';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
}

export function prepareVoucherEmail(options: VoucherEmail): { options: VoucherEmail; demo: boolean } {
  const inbox = process.env.VOUCHER_EMAIL_DEMO_RECIPIENT?.trim();
  if (!inbox) return { options, demo: false };
  if (!isEmail(inbox)) throw new Error('VOUCHER_EMAIL_DEMO_RECIPIENT must be a single email address.');

  const recipients = [
    ['To', formatRecipients(options.to)],
    ['CC', formatRecipients(options.cc)],
    ['BCC', formatRecipients(options.bcc)],
  ];
  const deliveryNote = `This email was sent only to ${inbox}.`;
  const notice = `<div style="margin:0 0 20px;padding:14px 16px;border:1px solid #f4c46b;border-radius:10px;background:#fff8e8;color:#795400;font:13px/1.6 Arial,sans-serif;">
    <strong>Intended recipients</strong><br>
    ${escapeHtml(deliveryNote)}<br>
    ${recipients.map(([label, value]) => `<strong>${label}:</strong> ${escapeHtml(value)}`).join('<br>')}
  </div>`;
  const bodyTag = /<body\b[^>]*>/i;
  const html = bodyTag.test(options.html)
    ? options.html.replace(bodyTag, (tag) => tag + notice)
    : notice + options.html;
  const text = ['Intended recipients', deliveryNote, ...recipients.map(([label, value]) => `${label}: ${value}`), '', options.text].join('\n');

  return {
    demo: true,
    options: { ...options, to: inbox, cc: undefined, bcc: undefined, envelope: undefined, replyTo: undefined, html, text },
  };
}
