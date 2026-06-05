const sgMail = require('@sendgrid/mail');
const Notification = require('../models/Notification');
const User = require('../models/User');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const notificationService = {
  /**
   * Send an in-app notification to a specific user.
   */
  async notifyUser(userId, type, title, message, link = null) {
    return Notification.create(userId, type, title, message, link);
  },

  /**
   * Send in-app notifications to all users with a given role.
   */
  async notifyRole(role, type, title, message, link = null) {
    const users = await User.findByRole(role);
    const promises = users.map(u => Notification.create(u.id, type, title, message, link));
    return Promise.all(promises);
  },

  /**
   * Send in-app notifications to ALL users (e.g. community announcements).
   * @param {string} type
   * @param {string} title
   * @param {string} message
   * @param {string|null} link
   * @param {number|null} excludeUserId - Optional user to skip (e.g. the author)
   */
  async notifyAll(type, title, message, link = null, excludeUserId = null) {
    const users = await User.findAll({ limit: 10000, offset: 0 });
    const targets = excludeUserId
      ? users.filter(u => u.id !== excludeUserId)
      : users;
    const promises = targets.map(u => Notification.create(u.id, type, title, message, link));
    return Promise.all(promises);
  },

  /**
   * Send in-app notifications to ALL staff roles (non-client users).
   * Covers: psychometrician, supervising_psychometrician, qc_psychometrician,
   *         psychologist, clinical_director
   */
  async notifyStaff(type, title, message, link = null, excludeUserId = null) {
    const staffRoles = [
      'psychometrician', 'supervising_psychometrician',
      'qc_psychometrician', 'psychologist', 'clinical_director',
    ];
    const allPromises = staffRoles.map(role =>
      User.findByRole(role).then(users => {
        const targets = excludeUserId ? users.filter(u => u.id !== excludeUserId) : users;
        return Promise.all(targets.map(u => Notification.create(u.id, type, title, message, link)));
      })
    );
    return Promise.all(allPromises);
  },

  /**
   * Send a notification email via SendGrid.
   */
  async sendNotificationEmail(toEmail, title, message) {
    const msg = {
      to: toEmail,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: `Barcarse – ${title}`,
      text: `${message}\n\n— Barcarse Psychological Services`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #2d3748;">${title}</h2>
          <p style="color: #4a5568; line-height: 1.6;">${message}</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="color: #a0aec0; font-size: 12px;">— Barcarse Psychological Services</p>
        </div>
      `,
    };

    await sgMail.send(msg);
  },
};

module.exports = notificationService;
