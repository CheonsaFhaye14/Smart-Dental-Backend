// utils/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false, // false for port 587 (TLS), true for port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Sends a "set up your account" or "reset your password" email
 * containing a one-time Supabase Auth link.
 */
async function sendSetupEmail({ to, firstname, setupLink, mode = 'invite' }) {
  const isReset = mode === 'reset';

  const subject = isReset
    ? 'Reset your Smart Dental Clinic password'
    : 'Set up your Smart Dental Clinic account';

  const introLine = isReset
    ? `We received a request to reset your password.`
    : `An account has been created for you at Smart Dental Clinic.`;

  const buttonLabel = isReset ? 'Reset Your Password' : 'Set Up Your Account';

  await transporter.sendMail({
    from: `"Smart Dental Clinic" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: `
      <p>Hi ${firstname},</p>
      <p>${introLine} Click below to ${isReset ? 'choose a new password' : 'set your password and log in'}:</p>
      <p><a href="${setupLink}">${buttonLabel}</a></p>
      <p>If you weren't expecting this, you can safely ignore this email.</p>
    `,
  });
}

module.exports = { transporter, sendSetupEmail };