const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');

const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip
    || 'unknown';
};

// GET /api/staff — List all staff
const getAllStaff = async (req, res, next) => {
  try {
    const { role } = req.query;
    const staff = await User.findAll({ role });
    return res.status(200).json({ success: true, data: staff });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff/:id — Get specific staff member
const getStaffById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }
    return res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

// PUT /api/staff/:id/role — Update staff role
const updateStaffRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    const validRoles = ['client', 'psychometrician', 'supervising_psychometrician', 'qc_psychometrician', 'psychologist', 'clinical_director'];

    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
      });
    }

    const updated = await User.updateRole(req.params.id, role);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    await ActivityLog.log(
      req.user.id, 'UPDATE_ROLE', 'user', parseInt(req.params.id),
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

// DELETE /api/staff/:id — Deactivate / remove staff
const deactivateStaff = async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);

    // Prevent self-deletion
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
    }

    const user = await User.findById(targetId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    await User.deleteById(targetId);

    await ActivityLog.log(
      req.user.id, 'DEACTIVATE_STAFF', 'user', targetId,
      getClientIP(req), { removedUser: user.email }
    );

    return res.status(200).json({
      success: true,
      message: 'Staff member has been removed.',
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

// GET /api/staff/:id/activity — View specific staff activity
const getStaffActivity = async (req, res, next) => {
  try {
    const logs = await ActivityLog.findByUserId(parseInt(req.params.id), 50);
    return res.status(200).json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAllStaff, getStaffById, updateStaffRole, deactivateStaff, getActivityLogs, getStaffActivity };
