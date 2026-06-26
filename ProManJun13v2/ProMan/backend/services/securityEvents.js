/**
 * securityEvents — central chokepoint for security-related events and the
 * Audit Action Management workflow.
 * ─────────────────────────────────────────────────────────────────────────
 * Every security event in the system should flow through `record()`. It:
 *   1. Resolves a SEVERITY (low / medium / high / critical) and the module's
 *      recommended action, escalation path and resolution procedure from the
 *      CATALOG below.
 *   2. Writes the event to `security_audit_log` (so it appears in Audit Logs).
 *   3. LOW  → logged only. Repeated low events (threshold breach) auto-escalate
 *      to a MEDIUM incident.
 *      MEDIUM / HIGH / CRITICAL → opens a tracked incident in
 *      `security_incidents` and notifies the Clinical Director (in-app + email).
 *
 * The CATALOG is the single editable source of truth for per-module response
 * actions. Action buttons rendered in the Action Center come straight from
 * `actions` here, so each module exposes its OWN response actions.
 *
 * NOTE ON ACTION EXECUTION: actions recorded against an incident are documented
 * response steps (logged to the incident timeline for the audit trail). Tier
 * 'executable' marks actions that map to a destructive operation a CD may also
 * perform elsewhere; we record the decision here rather than automate it, so
 * the Action Center never performs an irreversible operation implicitly.
 */
const db = require('../config/db');
const notificationService = require('./notificationService');

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const ORDERED = ['low', 'medium', 'high', 'critical'];

// Repeated LOW events for the same subject/IP within the window escalate to a
// single MEDIUM incident.
const THRESHOLD = { count: 5, windowMinutes: 15 };

// ── Per-module response actions (module → its own action buttons) ───────────
const A = (key, label, tier = 'documented') => ({ key, label, tier });

// ── CATALOG ─────────────────────────────────────────────────────────────────
// module → { label, escalationPath, resolutionProcedure[], actions[], events{} }
const CATALOG = {
  user_access: {
    label: 'User Account & Access',
    escalationPath: 'Security Staff → Clinical Director → System Administrator',
    resolutionProcedure: [
      'Verify user identity',
      'Confirm legitimacy of login attempt',
      'Restore account access if validated',
      'Document findings in audit trail',
    ],
    actions: [
      A('force_password_reset', 'Force Password Reset', 'executable'),
      A('force_logout', 'Force Logout', 'executable'),
      A('suspend_account', 'Suspend Account', 'executable'),
      A('unsuspend_account', 'Unsuspend Account', 'executable'),
      A('review_login_history', 'Review Login History'),
    ],
    events: {
      failed_login: { severity: 'low', title: 'Failed Login Attempt' },
      repeated_failed_login: { severity: 'high', title: 'Repeated Failed Login Attempts' },
      account_lockout: { severity: 'medium', title: 'Account Lockout' },
      login_new_geo: { severity: 'medium', title: 'Login from Unfamiliar Device or Location' },
      unauthorized_password_reset: { severity: 'medium', title: 'Unauthorized Password Reset Attempt' },
      suspicious_account_activity: { severity: 'high', title: 'Suspicious Account Activity' },
      role_escalation_attempt: { severity: 'critical', title: 'Role Escalation Attempt' },
      captcha_failure: { severity: 'low', title: 'CAPTCHA Verification Failed' },
      account_takeover: { severity: 'critical', title: 'Complete Account Takeover' },
    },
  },

  intake_scheduling: {
    label: 'Client Intake & Scheduling',
    escalationPath: 'Assigned Psychometrician → Clinical Director',
    resolutionProcedure: [
      'Validate appointment changes with involved parties',
      'Restore original records',
      'Record corrective actions',
    ],
    actions: [
      A('revert_change', 'Revert Unauthorized Changes', 'executable'),
      A('lock_appointment', 'Lock Affected Appointment Records', 'executable'),
      A('restrict_scheduling', 'Restrict Scheduling Privileges', 'executable'),
      A('review_activity', 'Review User Activity Logs'),
    ],
    events: {
      unauthorized_appointment_change: { severity: 'medium', title: 'Unauthorized Modification of Appointment Records' },
      unauthorized_intake_access: { severity: 'high', title: 'Unauthorized Access to Intake Forms' },
      mass_appointment_creation: { severity: 'high', title: 'Mass Appointment Creation Attempts' },
      reschedule_abuse: { severity: 'low', title: 'Repeated Cancellation / Rescheduling Abuse' },
    },
  },

  report_generation: {
    label: 'Report Generation',
    escalationPath: 'Supervising Psychometrician → QC → Clinical Director',
    resolutionProcedure: [
      'Verify authorized personnel involvement',
      'Validate report contents',
      'Restore approved version if altered',
      'Record incident resolution',
    ],
    actions: [
      A('suspend_generation', 'Suspend Report Generation Session', 'executable'),
      A('revert_version', 'Revert to Previous Approved Version', 'executable'),
      A('restrict_editing', 'Restrict Report Editing Privileges', 'executable'),
      A('integrity_review', 'Conduct Integrity Review'),
    ],
    events: {
      unauthorized_generation: { severity: 'high', title: 'Unauthorized Report Generation' },
      unauthorized_editing: { severity: 'high', title: 'Unauthorized Report Editing' },
      template_modification: { severity: 'medium', title: 'Modification of Report Templates' },
      version_anomaly: { severity: 'medium', title: 'Version Control Anomaly' },
      excessive_export: { severity: 'medium', title: 'Excessive Report Export Activity' },
      rule_violation: { severity: 'medium', title: 'Report Rule Violation' },
    },
  },

  report_storage: {
    label: 'Report Storage & Signing',
    escalationPath: 'QC Psychometrician → Clinical Director',
    resolutionProcedure: [
      'Verify authorized personnel involvement',
      'Validate stored report integrity (hash)',
      'Restore approved signed version if altered',
      'Record incident resolution',
    ],
    actions: [
      A('invalidate_signature', 'Invalidate Signature', 'executable'),
      A('halt_release', 'Halt Release Pipeline', 'executable'),
      A('revert_to_qc', 'Revert to QC Stage', 'executable'),
      A('integrity_review', 'Conduct Integrity Review'),
    ],
    events: {
      unauthorized_report_access: { severity: 'high', title: 'Unauthorized Report Access' },
      download_denied: { severity: 'medium', title: 'Report Download Denied' },
      bulk_report_export: { severity: 'high', title: 'Bulk Export of Client Reports' },
      signature_forgery: { severity: 'critical', title: 'Report Signature Forgery Attempt' },
      unauthorized_signing: { severity: 'high', title: 'Unauthorized Report Signing' },
    },
  },

  community: {
    label: 'Community Forum',
    escalationPath: 'Moderator → Clinical Director',
    resolutionProcedure: [
      'Review content against community policies',
      'Apply sanctions if necessary',
      'Document moderation actions',
    ],
    actions: [
      A('remove_content', 'Remove Content', 'executable'),
      A('lock_thread', 'Lock Discussion Thread', 'executable'),
      A('unlock_thread', 'Unlock Discussion Thread', 'executable'),
      A('suspend_account', 'Suspend Offending Account', 'executable'),
      A('notify_clinician', 'Notify Responsible Clinician'),
      A('escalate_violation', 'Escalate Repeated Violations'),
    ],
    events: {
      prohibited_content: { severity: 'medium', title: 'Posting Prohibited Content' },
      spam_posting: { severity: 'low', title: 'Spam or Mass Posting' },
      harassment: { severity: 'high', title: 'Harassment or Abusive Discussion' },
      unauthorized_content_modification: { severity: 'medium', title: 'Unauthorized Content Modification' },
      misinformation: { severity: 'medium', title: 'Misinformation' },
      // Crisis & Safety merged into Community Forum.
      crisis_detected: { severity: 'high', title: 'Crisis Indicator Detected' },
      safety_concern_raised: { severity: 'medium', title: 'Safety Concern Raised' },
    },
  },

  teleconference: {
    label: 'Teleconference',
    escalationPath: 'Hosting Clinician → Clinical Director',
    resolutionProcedure: [
      'Verify identities of participants',
      'Review session logs',
      'Notify affected clinician and client',
      'Document investigation outcome',
    ],
    actions: [
      A('remove_participant', 'Remove Participant', 'executable'),
      A('terminate_session', 'Terminate Suspicious Session', 'executable'),
      A('regenerate_token', 'Regenerate Meeting Access Token', 'executable'),
      A('restrict_session', 'Restrict Session Access', 'executable'),
    ],
    events: {
      unauthorized_join_attempt: { severity: 'medium', title: 'Unauthorized Participant Access' },
      token_abuse: { severity: 'high', title: 'Meeting Access Token Abuse' },
      otp_failure: { severity: 'low', title: 'Failed Meeting Join (OTP)' },
      repeated_otp_failure: { severity: 'medium', title: 'Multiple Failed Meeting Join Attempts' },
      session_hijack_attempt: { severity: 'critical', title: 'Session Hijacking Attempt' },
      unauthorized_recording: { severity: 'high', title: 'Unauthorized Recording Attempt' },
    },
  },

  data_protection: {
    label: 'Data Protection & Backup',
    escalationPath: 'Clinical Director → System Administrator → Incident Response',
    resolutionProcedure: [
      'Restore data from verified backup',
      'Validate integrity through hashing',
      'Conduct incident review',
      'Document recovery process',
    ],
    actions: [
      A('initiate_recovery', 'Initiate Backup Recovery'),
      A('verify_integrity', 'Verify Data Integrity (Hash)'),
      A('restrict_admin', 'Restrict Administrative Access', 'executable'),
      A('preserve_evidence', 'Preserve Forensic Evidence'),
    ],
    events: {
      backup_deletion_attempt: { severity: 'critical', title: 'Backup Deletion Attempt' },
      backup_restore_failure: { severity: 'high', title: 'Backup Restoration Failure' },
      data_integrity_violation: { severity: 'critical', title: 'Data Integrity Violation' },
      encryption_key_access: { severity: 'critical', title: 'Encryption Key Access Attempt' },
      audit_log_tampering: { severity: 'critical', title: 'Audit Log Tampering Attempt' },
      bulk_data_deletion: { severity: 'critical', title: 'Massive Data Exposure / Deletion' },
    },
  },

  // ── Gap modules (present in the codebase, absent from the source spec) ─────
  payments: {
    label: 'Payments & Billing',
    escalationPath: 'Billing Reviewer → Clinical Director',
    resolutionProcedure: [
      'Verify transaction legitimacy with the client',
      'Reconcile against payment records',
      'Restore correct billing state',
      'Document corrective measures',
    ],
    actions: [
      A('freeze_transaction', 'Freeze Transaction', 'executable'),
      A('flag_review', 'Flag for Manual Review'),
      A('reverse_payment', 'Reverse / Void Payment', 'executable'),
      A('review_payment_logs', 'Review Payment Logs'),
    ],
    events: {
      verification_anomaly: { severity: 'medium', title: 'Payment Verification Anomaly' },
      payment_tamper: { severity: 'high', title: 'Payment Record Tampering' },
      duplicate_payment_abuse: { severity: 'low', title: 'Repeated Payment Submission' },
    },
  },

  public_content: {
    label: 'Public Content',
    escalationPath: 'Content Editor → Clinical Director',
    resolutionProcedure: [
      'Review change against approved content',
      'Restore approved version',
      'Document corrective actions',
    ],
    actions: [
      A('revert_content', 'Revert Content', 'executable'),
      A('unpublish', 'Unpublish Content', 'executable'),
      A('review_history', 'Review Change History'),
    ],
    events: {
      unauthorized_content_change: { severity: 'medium', title: 'Unauthorized Public Content Change' },
      contact_form_abuse: { severity: 'low', title: 'Contact Form Abuse' },
    },
  },

  // Fallback for unmapped emissions.
  _default: {
    label: 'General Security',
    escalationPath: 'Clinical Director',
    resolutionProcedure: ['Investigate the event', 'Apply corrective action', 'Document the outcome'],
    actions: [A('investigate', 'Investigate'), A('document', 'Document Finding')],
    events: {},
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function prettify(s) {
  return String(s || 'Security Event').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function moduleDef(module) {
  return CATALOG[module] || CATALOG._default;
}

function resolveAction(module, actionKey) {
  return moduleDef(module).actions.find(a => a.key === actionKey) || null;
}

function bumpSeverity(sev) {
  const i = ORDERED.indexOf(sev);
  return i < 0 ? 'medium' : ORDERED[Math.min(i + 1, ORDERED.length - 1)];
}

// Active CD recipient emails across both the users and staff tables.
async function clinicalDirectorEmails() {
  const Staff = require('../models/Staff');
  const User = require('../models/User');
  const out = [];
  try {
    const staff = (await Staff.findAll({ role: 'clinical_director' })) || [];
    staff.filter(s => s.is_active && s.email).forEach(s => out.push(s.email));
  } catch (_) {}
  try {
    const users = (await User.findByRole('clinical_director')) || [];
    users.filter(u => u.email).forEach(u => out.push(u.email));
  } catch (_) {}
  return [...new Set(out)];
}

// ── Threshold check for repeated LOW events ──────────────────────────────────
async function thresholdBreached(eventType, userId, ip) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS c FROM security_audit_log
        WHERE event_type = $1
          AND created_at > NOW() - ($2 || ' minutes')::interval
          AND ( ($3::int IS NOT NULL AND user_id = $3)
             OR ($4::text IS NOT NULL AND ip_address = $4) )`,
      [eventType, String(THRESHOLD.windowMinutes), userId, ip]
    );
    return r.rows[0].c >= THRESHOLD.count;
  } catch (_) {
    return false;
  }
}

// Avoid spamming duplicate escalation incidents: reuse an open incident for the
// same module + event within the window if one already exists.
async function findOpenIncident(module, eventType, subjectUserId) {
  try {
    const r = await db.query(
      `SELECT id FROM security_incidents
        WHERE module = $1 AND event_type = $2
          AND status NOT IN ('resolved','closed')
          AND ($3::int IS NULL OR subject_user_id IS NOT DISTINCT FROM $3)
          AND created_at > NOW() - ($4 || ' minutes')::interval
        ORDER BY id DESC LIMIT 1`,
      [module, eventType, subjectUserId, String(THRESHOLD.windowMinutes)]
    );
    return r.rows[0]?.id || null;
  } catch (_) {
    return null;
  }
}

// Normalize loopback / IPv4-mapped IPv6 to a readable form for display.
//   ::ffff:127.0.0.1 → 127.0.0.1   ·   ::1 → 127.0.0.1
// When the app is reached over a network/tunnel, Express (trust proxy) already
// resolves the real client IP from X-Forwarded-For, so this only tidies loopback.
function normalizeIp(ip) {
  if (!ip) return ip;
  let s = String(ip).trim();
  if (s.toLowerCase().startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') s = '127.0.0.1';
  return s;
}

// ── Open an incident + first timeline row ────────────────────────────────────
async function openIncident({ eventId, module, eventType, title, severity, details, subjectUserId, subjectKind, targetType, targetId, ip, mod, recommendedAction }) {
  const r = await db.query(
    `INSERT INTO security_incidents
       (event_id, module, event_type, title, severity, status,
        recommended_action, escalation_path, resolution_procedure,
        subject_user_id, subject_kind, target_type, target_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      eventId, module, eventType, title, severity,
      recommendedAction || mod.actions.map(a => a.label).join('; '),
      mod.escalationPath,
      mod.resolutionProcedure.join(' → '),
      subjectUserId, subjectKind || null,
      targetType || null, targetId != null ? String(targetId) : null, ip,
    ]
  );
  const incidentId = r.rows[0].id;
  await db.query(
    `INSERT INTO security_incident_actions (incident_id, actor_id, action_type, label, to_value, note)
     VALUES ($1, NULL, 'created', $2, 'open', $3)`,
    [incidentId, title, details || `Auto-opened from ${mod.label} event (${severity}).`]
  );
  return incidentId;
}

// ── Notify the Clinical Director (in-app + email) ────────────────────────────
async function alertClinicalDirector({ incidentId, moduleLabel, title, severity }) {
  const sevLabel = severity.toUpperCase();
  const subject = `${sevLabel} security event — ${moduleLabel}`;
  const message = `${title} (${sevLabel}) was detected in ${moduleLabel}. Review and respond in the Action Center.`;
  const link = `profile.html?section=action-center&incident=${incidentId}`;
  try {
    // 'system_alert' is the closest canonical type allowed by notifications_type_check.
    await notificationService.notifyRoles(['clinical_director'], 'system_alert', subject, message, link);
  } catch (e) {
    console.error('⚠️  CD in-app alert failed:', e.message);
  }
  try {
    const emails = await clinicalDirectorEmails();
    await Promise.all(emails.map(to =>
      notificationService.sendNotificationEmail(to, subject, message).catch(() => {})
    ));
  } catch (e) {
    console.error('⚠️  CD email alert failed:', e.message);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Record a security event. Always best-effort: never throws into the caller.
 * @returns {Promise<{severity:string, incidentId:number|null}>}
 */
async function record({
  module, eventType, userId = null, actorId = null, ip = null,
  details = null, severityOverride = null, subjectUserId = null, subjectKind = null,
  targetType = null, targetId = null,
} = {}) {
  try {
    const mod = moduleDef(module);
    const ev = mod.events[eventType] || {};
    let severity = severityOverride || ev.severity || 'low';
    const title = ev.title || prettify(eventType);
    const subject = subjectUserId != null ? subjectUserId : userId;
    ip = normalizeIp(ip);

    // 1. Persist to the audit log feed.
    let eventId = null;
    try {
      const ins = await db.query(
        `INSERT INTO security_audit_log (user_id, event_type, action, reason, context, ip_address, severity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
        [userId, eventType, module, details, module, ip, severity]
      );
      eventId = ins.rows[0]?.id || null;
    } catch (_) { /* table may not exist yet — non-fatal */ }

    // 2. LOW → log only, unless repeated past the threshold.
    if (SEVERITY_RANK[severity] === SEVERITY_RANK.low) {
      const breached = await thresholdBreached(eventType, userId, ip);
      if (!breached) return { severity, incidentId: null };
      // Escalate to a single MEDIUM incident (dedupe against an open one).
      const existing = await findOpenIncident(module, eventType, subject);
      if (existing) {
        await db.query(
          `INSERT INTO security_incident_actions (incident_id, actor_id, action_type, note)
           VALUES ($1, NULL, 'note', $2)`,
          [existing, `Repeated low-severity ${eventType} events continued (threshold re-breached).`]
        ).catch(() => {});
        return { severity: 'medium', incidentId: existing };
      }
      severity = 'medium';
    }

    // 3. MEDIUM / HIGH / CRITICAL → open incident + alert CD.
    // Dedupe against an already-open incident for the same module/event/subject
    // within the window so repeated events don't spawn duplicate incidents or
    // flood the Clinical Director with email. A recurrence is appended to the
    // existing timeline instead.
    const open = await findOpenIncident(module, eventType, subject);
    if (open) {
      await db.query(
        `INSERT INTO security_incident_actions (incident_id, actor_id, action_type, note)
         VALUES ($1, NULL, 'note', $2)`,
        [open, `Recurrence: ${title} (${severity})${details ? ` — ${details}` : ''}.`]
      ).catch(() => {});
      await db.query(`UPDATE security_incidents SET updated_at = NOW() WHERE id = $1`, [open]).catch(() => {});
      return { severity, incidentId: open };
    }

    const incidentId = await openIncident({
      eventId, module, eventType, title, severity, details,
      subjectUserId: subject, subjectKind, targetType, targetId, ip, mod,
    });
    await alertClinicalDirector({ incidentId, moduleLabel: mod.label, title, severity });
    return { severity, incidentId };
  } catch (err) {
    console.error('⚠️  securityEvents.record failed:', err.message);
    return { severity: 'low', incidentId: null };
  }
}

// Trimmed catalog for the Action Center UI (module filters + action buttons).
function catalogForClient() {
  return Object.entries(CATALOG)
    .filter(([key]) => key !== '_default')
    .map(([key, m]) => ({
      key,
      label: m.label,
      escalationPath: m.escalationPath,
      resolutionProcedure: m.resolutionProcedure,
      actions: m.actions,
    }));
}

module.exports = {
  record,
  catalogForClient,
  moduleDef,
  resolveAction,
  bumpSeverity,
  normalizeIp,
  SEVERITY_RANK,
  ORDERED,
  CATALOG,
};
