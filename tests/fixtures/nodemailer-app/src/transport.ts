// @ts-nocheck
import nodemailer from 'nodemailer';

export const transporter = nodemailer.createTransport({
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  auth: {
    user: 'user@example.com',
    pass: 'secret',
  },
});
