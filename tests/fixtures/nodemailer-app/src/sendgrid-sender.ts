// @ts-nocheck
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY ?? '');

export async function sendAlert(to: string, subject: string) {
  return sgMail.send({
    to,
    from: 'alerts@example.com',
    subject,
    text: 'You have an alert.',
  });
}
