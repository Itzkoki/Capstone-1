const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Send a verification OTP email to the user.
 * @param {string} toEmail - Recipient email address
 * @param {string} otp - 6-digit OTP code (plaintext)
 * @param {string} fullName - User's full name for personalization
 */
const sendVerificationEmail = async (toEmail, otp, fullName) => {
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'ProMan – Verify Your Email Address',
    text: `Hi ${fullName},\n\nYour verification code is: ${otp}\n\nThis code expires in 15 minutes.\n\nIf you did not create an account, please ignore this email.\n\n— ProMan Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #2d3748;">Verify Your Email</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your verification code is:</p>
        <div style="background: #f7fafc; border: 2px dashed #4a90d9; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2b6cb0;">${otp}</span>
        </div>
        <p style="color: #718096; font-size: 14px;">This code expires in <strong>15 minutes</strong>.</p>
        <p style="color: #a0aec0; font-size: 12px;">If you did not create an account, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #a0aec0; font-size: 12px;">— ProMan Team</p>
      </div>
    `,
  };

  await sgMail.send(msg);
};

/**
 * Send a password reset link email to the user.
 * @param {string} toEmail - Recipient email address
 * @param {string} resetUrl - Full URL with token for password reset
 * @param {string} fullName - User's full name for personalization
 */
const sendPasswordResetEmail = async (toEmail, resetUrl, fullName) => {
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Barcarse – Reset Your Password',
    text: `Hi ${fullName},\n\nYou requested a password reset. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 30 minutes.\n\nIf you did not request this, please ignore this email.\n\n— Barcarse Psychological Services`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #2d3748;">Reset Your Password</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>You requested a password reset. Click the button below to set a new password:</p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: #34c759; color: #fff; font-weight: 600; font-size: 16px; text-decoration: none; border-radius: 10px; box-shadow: 0 4px 14px rgba(52,199,89,0.3);">Reset Password</a>
        </div>
        <p style="color: #718096; font-size: 14px;">This link expires in <strong>30 minutes</strong>.</p>
        <p style="color: #718096; font-size: 13px;">If the button doesn't work, copy and paste this URL into your browser:</p>
        <p style="color: #2b6cb0; font-size: 13px; word-break: break-all;">${resetUrl}</p>
        <p style="color: #a0aec0; font-size: 12px;">If you did not request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #a0aec0; font-size: 12px;">— Barcarse Psychological Services</p>
      </div>
    `,
  };

  await sgMail.send(msg);
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
