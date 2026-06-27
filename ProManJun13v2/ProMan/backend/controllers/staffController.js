const bcrypt = require('bcryptjs');
const Staff = require('../models/Staff');
const { COUNSELING_ROLES, ASSESSMENT_ROLES } = require('../models/Staff');
const ActivityLog = require('../models/ActivityLog');
const { invalidateAccountCache } = require('../middleware/auth');

// Keep hashing strength consistent with the rest of the app.
const SALT_ROUNDS = 12;

// Roles a staff account may hold. 'staff' is the default assigned at creation;
// the Clinical Director promotes/changes from there. (No 'client' — clients live
// in the separate `users` table and never appear in Staff Management.)
const VALID_ROLES = [
  'staff',
  'psychometrician',
  'supervising_psychometrician',
  'qc_psychometrician',
  'psychologist',
  'clinical_director',
];

const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip
    || 'unknown';
};

// Best-effort activity logging. The activity_logs.user_id column references
// users(id); a staff actor's id lives in the separate `staff` table, so an
// insert may violate that FK. We never let an audit-log failure break the
// actual operation — hence the swallow.
const safeLog = async (...args) => {
  try {
    await ActivityLog.log(...args);
  } catch (_) {
    /* non-fatal: staff actor id may not exist in users(id) during the interim */
  }
};

// GET /api/staff — List all staff (from the staff table only)
const getAllStaff = async (req, res, next) => {
  try {
    const { role } = req.query;
    const staff = await Staff.findAll({ role });
    return res.status(200).json({ success: true, data: staff });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff-directory/assignable — Public list of assignable staff for
// client-facing pickers (intake counselor/therapist, teleconference). Returns
// only active staff with a clinical role, including their specialization.
// Optional ?gender=Male|Female filter. Never exposes emails or status.
const getAssignableStaff = async (req, res, next) => {
  try {
    const { gender, service } = req.query;
    let roles;
    if (service === 'counseling') roles = COUNSELING_ROLES;
    else if (service === 'assessment') roles = ASSESSMENT_ROLES;
    const staff = await Staff.findAssignable({ gender, roles });
    const data = staff.map((s) => ({
      staff_id: s.staff_id,
      name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim(),
      gender: s.gender || null,
      role: s.role,
      specialization: s.specialization || null,
      schedule: s.schedule || [],
    }));
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff/:id — Get a specific staff member
const getStaffById = async (req, res, next) => {
  try {
    const staff = await Staff.findById(req.params.id);
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }
    return res.status(200).json({ success: true, data: staff });
  } catch (error) {
    next(error);
  }
};

// POST /api/staff — Create a staff account (internal, Clinical Director only).
// This is the only account-creation path; role is always 'staff' at creation.
const createStaff = async (req, res, next) => {
  try {
    const { first_name, last_name, gender, email, username, password, specialization, schedule } = req.body;

    if (await Staff.existsUsername(username)) {
      return res.status(409).json({ success: false, message: 'That username is already taken.' });
    }
    if (email && await Staff.existsEmail(email)) {
      return res.status(409).json({ success: false, message: 'That email is already in use.' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const staff = await Staff.create({ first_name, last_name, gender, email, username, password_hash, specialization, schedule: Array.isArray(schedule) ? schedule : [] });

    await safeLog(
      req.user.id, 'CREATE_STAFF', 'staff', staff.staff_id,
      getClientIP(req), { username: staff.username }
    );

    return res.status(201).json({
      success: true,
      message: 'Staff account created.',
      data: staff,
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/staff/:id/role — Update a staff member's role
const updateStaffRole = async (req, res, next) => {
  try {
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
      });
    }

    const updated = await Staff.updateRole(req.params.id, role);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    await safeLog(
      req.user.id, 'UPDATE_ROLE', 'staff', parseInt(req.params.id),
      getClientIP(req), { newRole: role }
    );

    return res.status(200).json({
      success: true,
      message: `Role updated to ${role}.`,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/staff/:id/status — Activate or deactivate a staff account
const setStaffStatus = async (req, res, next) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'is_active must be a boolean (true to activate, false to deactivate).',
      });
    }

    const targetId = parseInt(req.params.id);

    // Prevent the acting director from deactivating their own account.
    if (!is_active && targetId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
    }

    const updated = await Staff.setActive(targetId, is_active);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }
    // Reflect the status change on the staff member's very next request
    // (the authenticate middleware caches account status for a few seconds).
    try { invalidateAccountCache('staff', targetId); } catch (_) {}

    await safeLog(
      req.user.id, is_active ? 'ACTIVATE_STAFF' : 'DEACTIVATE_STAFF', 'staff', targetId,
      getClientIP(req), { username: updated.username }
    );

    return res.status(200).json({
      success: true,
      message: is_active ? 'Staff account activated.' : 'Staff account deactivated.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff/activity-logs — View all activity logs
const getActivityLogs = async (req, res, next) => {
  try {
    const { userId, action, startDate, endDate, limit, offset } = req.query;
    const logs = await ActivityLog.findAll({
      userId: userId ? parseInt(userId) : undefined,
      action,
      startDate,
      endDate,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    return res.status(200).json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff/:id/activity — View a specific staff member's activity
const getStaffActivity = async (req, res, next) => {
  try {
    const logs = await ActivityLog.findByUserId(parseInt(req.params.id), 50);
    return res.status(200).json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllStaff,
  getAssignableStaff,
  getStaffById,
  createStaff,
  updateStaffRole,
  setStaffStatus,
  getActivityLogs,
  getStaffActivity,
};
