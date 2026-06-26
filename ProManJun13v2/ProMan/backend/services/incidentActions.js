/**
 * incidentActions — executes the "executable" response actions from the Action
 * Center against real system operations.
 * ─────────────────────────────────────────────────────────────────────────
 * An incident only knows its SUBJECT (subject_user_id + subject_kind) and the
 * source IP, so the actions we can truly automate are the account-targeted ones:
 *   • force_password_reset    → flag must_reset_password (clients); after the
 *                               next login + OTP the user is sent to the reset
 *                               page. No email is sent.
 *   • require_mfa             → terminate sessions in real time; the next login
 *                               re-runs the email-OTP second factor.
 *   • suspend_* / restrict_*  → deactivate the account AND terminate sessions in
 *                               real time (next request is rejected).
 *   • unsuspend_account       → reactivate the account.
 *
 * Resource-targeted actions act on the target captured at emission
 * (incident.target_type + target_id):
 *   • remove_participant / restrict_session → kick / deny a participant from the
 *                               captured teleconference session.
 *   • lock_thread / remove_content → hide the captured thread/comment/article
 *                               from the public community (staff/CD can still
 *                               review it).
 *
 * Actions with no wired operation (and no captured target) are recorded as
 * DOCUMENTED response steps; `execute()` returns { executed:false } and the
 * controller logs them to the timeline.
 */
const User = require('../models/User');
const Staff = require('../models/Staff');

// Resolve the incident's subject account from the correct table.
async function resolveSubject(incident) {
  const id = incident.subject_user_id;
  if (!id) return null;
  const kind = incident.subject_kind;
  const asUser = async () => {
    const u = await User.findById(id);
    return u ? { kind: 'user', id: u.id, email: u.email, name: u.full_name } : null;
  };
  const asStaff = async () => {
    const s = await Staff.findById(id);
    return s ? { kind: 'staff', id: s.staff_id, email: s.email, name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim() } : null;
  };
  if (kind === 'staff') return (await asStaff()) || (await asUser());
  if (kind === 'user') return (await asUser()) || (await asStaff());
  // Unknown kind — try client first, then staff.
  return (await asUser()) || (await asStaff());
}

// Terminate the subject's active sessions in real time (next request → 401).
async function terminateSessions(subject) {
  if (subject.kind === 'staff') await Staff.invalidateSessions(subject.id);
  else await User.invalidateSessions(subject.id);
}

// Deactivate the account AND end its sessions so the block takes effect at once.
async function deactivate(subject) {
  if (subject.kind === 'staff') await Staff.setActive(subject.id, false);
  else await User.setActive(subject.id, false);
  await terminateSessions(subject);
  return `Account ${subject.email || '#' + subject.id} suspended — login disabled and active session ended.`;
}

// Hide a community item (captured at emission) from the public forum. Public
// listing queries filter status='approved', so a non-approved status removes it
// from clients while staff/CD can still review it (e.g. findByThreadForStaff).
async function hideContent(incident) {
  const t = incident.target_type, id = incident.target_id;
  if (!id) throw new Error('No content target was captured on this incident.');
  if (t === 'thread') {
    await require('../models/ForumThread').updateStatus(id, 'rejected');
    return `Thread #${id} hidden from the community (no longer public; staff/CD can still review it).`;
  }
  if (t === 'reply') {
    await require('../models/ForumReply').updateStatus(id, 'hidden');
    return `Comment #${id} hidden from the community (no longer public; staff/CD can still review it).`;
  }
  if (t === 'article') {
    await require('../models/Article').updateStatus(id, 'rejected');
    return `Article #${id} unpublished.`;
  }
  throw new Error(`Cannot hide content of type "${t || 'unknown'}".`);
}

// Restore a previously hidden community item back to public ('approved').
async function restoreContent(incident) {
  const t = incident.target_type, id = incident.target_id;
  if (!id) throw new Error('No content target was captured on this incident.');
  if (t === 'thread') {
    await require('../models/ForumThread').updateStatus(id, 'approved');
    return `Thread #${id} unlocked and restored to the community.`;
  }
  if (t === 'reply') {
    await require('../models/ForumReply').updateStatus(id, 'approved');
    return `Comment #${id} unlocked and restored to the community.`;
  }
  if (t === 'article') {
    await require('../models/Article').updateStatus(id, 'approved');
    return `Article #${id} re-published.`;
  }
  throw new Error(`Cannot unlock content of type "${t || 'unknown'}".`);
}

// actionKey → handler(subject, incident) → message string (throws on hard error)
const HANDLERS = {
  // Force Password Reset — flag only, no email. The next login + OTP redirects
  // the client to the reset-password page.
  async force_password_reset(subject) {
    if (subject.kind !== 'user') throw new Error('Force password reset applies to client accounts only.');
    await User.setMustResetPassword(subject.id, true);
    await terminateSessions(subject); // end the current session so they must log in again
    return `Password reset required for ${subject.email || '#' + subject.id}; they will be sent to the reset page after their next login + OTP.`;
  },

  // Force Logout — end sessions in real time. The next request is rejected and
  // the user must sign in again (re-running the email-OTP second factor).
  async force_logout(subject) {
    await terminateSessions(subject);
    return `Session ended for ${subject.email || '#' + subject.id}; the user must sign in again.`;
  },

  // Suspension / access-restriction variants deactivate + end sessions.
  suspend_account: (s) => deactivate(s),
  suspend_admin: (s) => deactivate(s),
  restrict_access: (s) => deactivate(s),
  restrict_admin: (s) => deactivate(s),

  // Unsuspend — reactivate the account.
  async unsuspend_account(subject) {
    if (subject.kind === 'staff') await Staff.setActive(subject.id, true);
    else await User.setActive(subject.id, true);
    return `Account ${subject.email || '#' + subject.id} reactivated.`;
  },

  // ── Teleconference (acts on the captured session target + subject participant) ──
  async remove_participant(_subject, incident) {
    if (incident.target_type !== 'session' || !incident.target_id) throw new Error('No session target captured on this incident.');
    if (!incident.subject_user_id) throw new Error('No participant identified to remove.');
    const r = await require('../models/TeleconferenceSession').removeParticipant(incident.target_id, incident.subject_user_id);
    if (!r) throw new Error('That participant is not in the session.');
    return `Participant #${incident.subject_user_id} removed from session #${incident.target_id} (kicked and blocked from rejoining).`;
  },
  async restrict_session(_subject, incident) {
    if (incident.target_type !== 'session' || !incident.target_id) throw new Error('No session target captured on this incident.');
    if (!incident.subject_user_id) throw new Error('No participant identified to restrict.');
    const r = await require('../models/TeleconferenceSession').setAdmitStatus(incident.target_id, incident.subject_user_id, 'denied');
    if (!r) throw new Error('That participant is not in the session.');
    return `Access to session #${incident.target_id} restricted for participant #${incident.subject_user_id}.`;
  },

  // ── Community (acts on the captured content target) ──
  lock_thread: (_s, incident) => hideContent(incident),
  remove_content: (_s, incident) => hideContent(incident),
  unlock_thread: (_s, incident) => restoreContent(incident),
};

// Actions that act on a captured resource target, not a subject account.
const TARGET_ACTIONS = new Set(['remove_participant', 'restrict_session', 'lock_thread', 'remove_content', 'unlock_thread']);

/**
 * Attempt to execute a response action.
 * @returns {Promise<{executed:boolean, message:string}>}
 */
async function execute({ actionKey, incident }) {
  const handler = HANDLERS[actionKey];
  if (!handler) {
    return { executed: false, message: 'Recorded as a documented response (no automated operation is wired for this action).' };
  }
  // Resource-targeted actions act on the captured target, not a subject account.
  let subject = null;
  if (!TARGET_ACTIONS.has(actionKey)) {
    subject = await resolveSubject(incident);
    if (!subject) {
      return { executed: false, message: 'Recorded as documented — no resolvable subject account for this incident.' };
    }
  }
  try {
    const message = await handler(subject, incident);
    return { executed: true, message };
  } catch (err) {
    return { executed: false, message: `Could not auto-execute: ${err.message}. Recorded as documented response.` };
  }
}

module.exports = { execute };
