const sgMail = require('@sendgrid/mail');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Staff = require('../models/Staff');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const notificationService = {
  /**
   * Send an in-app notification to a specific recipient.
   * `recipientType` selects the id namespace: 'user' (clients, the default) or
   * 'staff' (staff_id). It MUST match the table the id came from, otherwise the
   * recipient — who reads by the id they authenticate with — never sees it.
   */
  async notifyUser(userId, type, title, message, link = null, recipientType = 'user') {
    return Notification.create(userId, type, title, message, link, recipientType);
  },

  /**
   * Send in-app notifications to everyone holding a given role — in BOTH the
   * legacy `users` table and the dedicated `staff` table. Staff accounts moved
   * to the `staff` table would otherwise never receive role broadcasts.
   */
  async notifyRole(role, type, title, message, link = null) {
    const users = await User.findByRole(role);
    await Promise.all(users.map(u => Notification.create(u.id, type, title, message, link, 'user')));
    // Also reach staff-table accounts holding this role.
    await this.notifyStaffRole(role, type, title, message, link);
  },

  /**
   * Send a notification to EACH of several roles (users + staff tables). Use
   * this to assign a workflow notification to exactly the role(s) responsible
   * for it, so other roles never receive (or can see) it. A user holds a single
   * role, so there are no cross-role duplicates.
   * @param {string[]|string} roles
   */
  async notifyRoles(roles, type, title, message, link = null) {
    const list = Array.isArray(roles) ? roles : [roles];
    for (const role of list) {
      await this.notifyRole(role, type, title, message, link);
    }
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
    const promises = targets.map(u => Notification.create(u.id, type, title, message, link, 'user'));
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
    // Legacy users-table staff.
    const userPromises = staffRoles.map(role =>
      User.findByRole(role).then(users => {
        const targets = excludeUserId ? users.filter(u => u.id !== excludeUserId) : users;
        return Promise.all(targets.map(u => Notification.create(u.id, type, title, message, link, 'user')));
      })
    );
    // Dedicated staff-table accounts (all active clinical staff).
    const staffRows = (await Staff.findAll({})).filter(s => s.is_active);
    const staffTargets = excludeUserId
      ? staffRows.filter(s => s.staff_id !== excludeUserId)
      : staffRows;
    const staffPromises = staffTargets.map(s => Notification.create(s.staff_id, type, title, message, link, 'staff'));

    return Promise.all([...userPromises, ...staffPromises]);
  },

  /**
   * Send in-app notifications to STAFF-TABLE accounts holding a given role.
   * Staff now live in the dedicated `staff` table (staff_id), separate from the
   * `users` table that notifyRole/notifyStaff target. Use this alongside
   * notifyRole when a role (e.g. clinical_director) may exist in either table,
   * so the recipient is notified regardless of which table their account is in.
   * Only active staff are notified.
   */
  async notifyStaffRole(role, type, title, message, link = null) {
    const staff = await Staff.findAll({ role });
    const targets = staff.filter(s => s.is_active);
    return Promise.all(
      targets.map(s => Notification.create(s.staff_id, type, title, message, link, 'staff'))
    );
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
