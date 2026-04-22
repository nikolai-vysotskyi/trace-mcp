// @ts-nocheck
import { transporter } from './transport';

export async function sendWelcomeEmail(to: string, name: string) {
  return transporter.sendMail({
    from: 'noreply@example.com',
    to,
    subject: 'Welcome',
    html: `<p>Hi ${name}, welcome!</p>`,
  });
}

export async function sendPasswordReset(to: string, link: string) {
  return transporter.sendMail({
    from: 'noreply@example.com',
    to,
    subject: 'Password reset',
    text: `Reset your password: ${link}`,
  });
}
