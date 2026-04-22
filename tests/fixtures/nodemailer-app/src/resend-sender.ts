// @ts-nocheck
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendReceipt(to: string) {
  return resend.emails.send({
    from: 'billing@example.com',
    to,
    subject: 'Your receipt',
    html: '<p>Thanks!</p>',
  });
}
