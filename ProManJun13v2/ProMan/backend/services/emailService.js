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
    text: `Hi ${fullName},\n\nYour verification code is: ${otp}\n\nThis code expires in 2 minutes.\n\nIf you did not create an account, please ignore this email.\n\n— ProMan Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #2d3748;">Verify Your Email</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your verification code is:</p>
        <div style="background: #f7fafc; border: 2px dashed #4a90d9; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2b6cb0;">${otp}</span>
        </div>
        <p style="color: #718096; font-size: 14px;">This code expires in <strong>2 minutes</strong>.</p>
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

/**
 * Send a teleconference access OTP to the user.
 */
const sendTeleconfOtpEmail = async (toEmail, otp, fullName) => {
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Barcarse – Teleconference Access Code',
    text: `Hi ${fullName},\n\nYour teleconference access code is: ${otp}\n\nThis code expires in 2 minutes.\n\nIf you did not request this, please ignore this email.\n\n— Barcarse Psychological Services`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1565c0;">Teleconference Access Verification</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Use the code below to verify your identity and join your teleconference session:</p>
        <div style="background: #e3f2fd; border: 2px dashed #1565c0; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #0d47a1;">${otp}</span>
        </div>
        <p style="color: #718096; font-size: 14px;">This code expires in <strong>2 minutes</strong> and can only be used once.</p>
        <p style="color: #a0aec0; font-size: 12px;">If you did not attempt to join a teleconference session, please contact support immediately.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #a0aec0; font-size: 12px;">— Barcarse Psychological Services</p>
      </div>
    `,
  };
  await sgMail.send(msg);
};

/**
 * Send an email OTP that gates access to a sensitive staff-only module
 * (Case Management, Staff Management, Payment Verification).
 * @param {string} toEmail     - Recipient email address
 * @param {string} otp         - 6-digit code
 * @param {string} fullName    - Recipient name for personalization
 * @param {string} moduleLabel - Human-readable module name (e.g. "Payment Verification")
 */
const sendModuleAccessOtpEmail = async (toEmail, otp, fullName, moduleLabel) => {
  const label = moduleLabel || 'a secure module';
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: `Barcarse – ${label} Access Code`,
    text: `Hi ${fullName},\n\nYour access code for ${label} is: ${otp}\n\nThis code expires in 2 minutes and can only be used once.\n\nIf you did not attempt to access ${label}, please contact support immediately.\n\n— Barcarse Psychological Services`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1565c0;">${label} Access Verification</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Use the code below to verify your identity and access <strong>${label}</strong>:</p>
        <div style="background: #e3f2fd; border: 2px dashed #1565c0; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #0d47a1;">${otp}</span>
        </div>
        <p style="color: #718096; font-size: 14px;">This code expires in <strong>2 minutes</strong> and can only be used once.</p>
        <p style="color: #a0aec0; font-size: 12px;">If you did not attempt to access ${label}, please contact support immediately.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #a0aec0; font-size: 12px;">— Barcarse Psychological Services</p>
      </div>
    `,
  };
  await sgMail.send(msg);
};

/**
 * Send a single-use teleconference invitation link to a client.
 * @param {string} toEmail   - Recipient email address
 * @param {string} fullName  - Client's full name for personalization
 * @param {string} joinUrl   - Full URL containing the single-use token
 * @param {Date}   expiresAt - When the link stops working
 */
const sendTeleconfInviteEmail = async (toEmail, fullName, joinUrl, expiresAt) => {
  const when = expiresAt ? new Date(expiresAt).toLocaleString() : 'soon';
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Barcarse – Your Teleconference Invitation',
    text: `Hi ${fullName},\n\nYou have been invited to a secure teleconference session.\n\nJoin using this single-use link (valid until ${when}):\n${joinUrl}\n\nThis link works only once and only for your account. Do not share it.\n\nIf you did not expect this, please ignore this email.\n\n— Barcarse Psychological Services`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1565c0;">Your Teleconference Invitation</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>You have been invited to a secure teleconference session. Click the button below to join:</p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${joinUrl}" style="display: inline-block; padding: 14px 32px; background: #1565c0; color: #fff; font-weight: 600; font-size: 16px; text-decoration: none; border-radius: 10px;">Join Teleconference</a>
        </div>
        <p style="color: #718096; font-size: 14px;">This is a <strong>single-use link</strong>, valid until <strong>${when}</strong>. It works only once and only for your account.</p>
        <p style="color: #e53e3e; font-size: 13px;">For your security, do not share this link with anyone.</p>
        <p style="color: #718096; font-size: 13px;">If the button doesn't work, copy and paste this URL into your browser:</p>
        <p style="color: #2b6cb0; font-size: 13px; word-break: break-all;">${joinUrl}</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #a0aec0; font-size: 12px;">— Barcarse Psychological Services</p>
      </div>
    `,
  };
  await sgMail.send(msg);
};

/**
 * Forward a public "Contact Us" inquiry to the clinic inbox.
 * The visitor's address is set as Reply-To so staff can reply directly.
 * @param {object} data - { name, email, subject, message }
 */
const sendContactMessage = async ({ name, email, subject, message }) => {
  const inbox = process.env.CONTACT_INBOX_EMAIL || 'bpsychserv2023@gmail.com';
  const safe = (s) => String(s || '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
  const msg = {
    to: inbox,
    from: process.env.SENDGRID_FROM_EMAIL,
    replyTo: email,
    subject: `[Website Inquiry] ${subject}`,
    text: `New contact form submission from the BPS website.\n\nName: ${name}\nEmail: ${email}\nSubject: ${subject}\n\nMessage:\n${message}\n`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #14342a;">New Website Inquiry</h2>
        <p style="color:#374151;">You received a new message through the Contact Us form.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <tr><td style="padding:6px 0; color:#6b7280; width:90px;">Name</td><td style="padding:6px 0; color:#111827;"><strong>${safe(name)}</strong></td></tr>
          <tr><td style="padding:6px 0; color:#6b7280;">Email</td><td style="padding:6px 0; color:#111827;">${safe(email)}</td></tr>
          <tr><td style="padding:6px 0; color:#6b7280;">Subject</td><td style="padding:6px 0; color:#111827;">${safe(subject)}</td></tr>
        </table>
        <div style="background:#f7fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; color:#111827; white-space:pre-wrap;">${safe(message)}</div>
        <p style="color:#a0aec0; font-size:12px; margin-top:20px;">Reply directly to this email to respond to ${safe(name)}.</p>
      </div>
    `,
  };

  await sgMail.send(msg);
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendTeleconfOtpEmail, sendModuleAccessOtpEmail, sendTeleconfInviteEmail, sendContactMessage };
