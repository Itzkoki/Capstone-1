const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const notificationService = require('../services/notificationService');
const User = require('../models/User');

const isStaff = (role) => role && role !== 'client';

// ── GET /api/appointments — list ──
const getAppointments = async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let data;
    if (isStaff(req.user.role)) {
      data = await Appointment.findAll({ status, limit: parseInt(limit), offset: parseInt(offset) });
    } else {
      data = await Appointment.findByClient(req.user.id, { status, limit: parseInt(limit), offset: parseInt(offset) });
    }
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/counts — status counts ──
const getStatusCounts = async (req, res, next) => {
  try {
    const counts = await Appointment.countByStatus();
    return res.json({ success: true, data: counts });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/:id — detail ──
const getAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (!isStaff(req.user.role) && appt.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.json({ success: true, data: appt });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/check-conflicts?datetime=... ──
const checkConflicts = async (req, res, next) => {
  try {
    const { datetime } = req.query;
    if (!datetime) return res.status(400).json({ success: false, message: 'datetime is required.' });

    const conflicts = await Appointment.checkConflict(datetime);
    return res.json({
      success: true,
      hasConflict: conflicts.length > 0,
      conflicts,
    });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/approve — staff approves schedule ──
const approveSchedule = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (!['pending_review'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot approve from status "${appt.status}".` });
    }

    // Check for conflicts
    const conflicts = await Appointment.checkConflict(appt.preferred_datetime, appt.id);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Schedule conflict detected. Another appointment is already booked within 1 hour of this time.',
        conflicts,
      });
    }

    const updated = await Appointment.approve(appt.id, req.user.id);

    // Notify client
    try {
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'Appointment Approved',
        `Your preferred schedule has been approved! Your appointment is confirmed for ${new Date(updated.approved_datetime).toLocaleString('en-PH')}.`,
        'intakeform.html'
      );
    } catch (e) { console.error('Approval notification failed:', e.message); }

    // Notify staff
    try {
      await notificationService.notifyStaff(
        'appointment',
        'Appointment Approved',
        `Appointment #${appt.id} has been approved by ${req.user.role}.`,
        'intake-submissions.html'
      );
    } catch (e) {}

    return res.json({ success: true, message: 'Schedule approved.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/propose-reschedule — staff proposes new time ──
const proposeReschedule = async (req, res, next) => {
  try {
    const { proposed_datetime, staff_notes } = req.body;
    if (!proposed_datetime) {
      return res.status(400).json({ success: false, message: 'proposed_datetime is required.' });
    }

    const proposedDt = new Date(proposed_datetime);
    if (proposedDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'Proposed datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Check daily limit on the proposed date
    const dateStr = proposed_datetime.split('T')[0] || new Date(proposed_datetime).toISOString().split('T')[0];
    const count = await Appointment.countByDate(dateStr);
    if (count >= MAX_PER_DAY) {
      return res.status(409).json({
        success: false,
        message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients). Please choose another date.`,
      });
    }

    // Check if the proposed time slot is already booked
    const bookedSlots = await Appointment.getBookedSlots(dateStr);
    const proposedHour = `${String(proposedDt.getHours()).padStart(2, '0')}:${String(proposedDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(proposedHour)) {
      return res.status(409).json({
        success: false,
        message: 'This time slot is already booked. Please choose another available time.',
      });
    }

    // Check for conflicts on the proposed datetime
    const conflicts = await Appointment.checkConflict(proposed_datetime, appt.id);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'The proposed schedule conflicts with an existing appointment.',
        conflicts,
      });
    }

    const updated = await Appointment.proposeReschedule(appt.id, req.user.id, proposed_datetime, staff_notes);

    // Notify client
    try {
      const staffUser = await User.findById(req.user.id);
      const staffName = staffUser ? staffUser.full_name : 'Staff';
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'New Schedule Proposed',
        `${staffName} has proposed a new schedule for your appointment: ${new Date(proposed_datetime).toLocaleString('en-PH')}. ${staff_notes ? 'Note: ' + staff_notes : ''} Please confirm or request a different time.`,
        'intakeform.html'
      );
    } catch (e) { console.error('Reschedule notification failed:', e.message); }

    return res.json({ success: true, message: 'Reschedule proposed.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/confirm — client confirms ──
const clientConfirm = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    if (!['approved', 'reschedule_proposed'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot confirm from status "${appt.status}".` });
    }

    const updated = await Appointment.clientConfirm(appt.id);

    // Notify staff
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyStaff(
        'appointment',
        'Appointment Confirmed',
        `${clientName} has confirmed their appointment for ${new Date(updated.approved_datetime).toLocaleString('en-PH')}.`,
        'intake-submissions.html'
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Appointment Approved');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment confirmed.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/decline — client declines ──
const clientDecline = async (req, res, next) => {
  try {
    const { notes } = req.body;
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const updated = await Appointment.clientDecline(appt.id, notes);

    // Notify staff
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyStaff(
        'appointment',
        'Appointment Declined',
        `${clientName} has declined their appointment.${notes ? ' Reason: ' + notes : ''}`,
        'intake-submissions.html'
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Appointment Approved');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment declined.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/request-change — client proposes new time ──
const clientRequestChange = async (req, res, next) => {
  try {
    const { new_datetime, notes } = req.body;
    if (!new_datetime) {
      return res.status(400).json({ success: false, message: 'new_datetime is required.' });
    }

    const newDt = new Date(new_datetime);
    if (newDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'New datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const updated = await Appointment.clientRequestChange(appt.id, new_datetime, notes);

    // Notify staff
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyStaff(
        'appointment',
        'Schedule Change Requested',
        `${clientName} has requested a new schedule: ${new Date(new_datetime).toLocaleString('en-PH')}.${notes ? ' Note: ' + notes : ''} Please review.`,
        'intake-submissions.html'
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    return res.json({ success: true, message: 'Schedule change requested. Staff will review.', data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/availability?date=YYYY-MM-DD ──
const MAX_PER_DAY = 5;

const getAvailability = async (req, res, next) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date query parameter is required (YYYY-MM-DD).' });

    const count = await Appointment.countByDate(date);
    const bookedSlots = await Appointment.getBookedSlots(date);

    return res.json({
      success: true,
      data: {
        date,
        count,
        maxPerDay: MAX_PER_DAY,
        bookedSlots,
        isFull: count >= MAX_PER_DAY,
        remaining: Math.max(0, MAX_PER_DAY - count),
      },
    });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/cancel ──
const cancelAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Only the appointment owner or staff can cancel
    if (!isStaff(req.user.role) && appt.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Cannot cancel already cancelled or declined appointments
    if (['cancelled', 'declined'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Appointment is already ${appt.status}.` });
    }

    const updated = await Appointment.cancel(appt.id);

    // Notify the other party
    try {
      if (isStaff(req.user.role)) {
        // Staff cancelled — notify client
        await notificationService.notifyUser(
          appt.client_id, 'appointment',
          'Appointment Cancelled',
          'Your appointment has been cancelled by staff. Please submit a new intake form to reschedule.',
          'intakeform.html'
        );
      } else {
        // Client cancelled — notify staff
        const clientUser = await User.findById(appt.client_id);
        const clientName = clientUser ? clientUser.full_name : 'Client';
        await notificationService.notifyStaff(
          'appointment',
          'Appointment Cancelled',
          `${clientName} has cancelled their appointment #${appt.id}. The time slot is now available.`,
          'intake-submissions.html'
        );
      }
    } catch (e) { console.error('Cancel notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment cancelled. The time slot is now available for others.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/edit ──
const editAppointment = async (req, res, next) => {
  try {
    const { new_datetime } = req.body;
    if (!new_datetime) {
      return res.status(400).json({ success: false, message: 'new_datetime is required.' });
    }

    const newDt = new Date(new_datetime);
    if (newDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'New datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Only the appointment owner or staff can edit
    if (!isStaff(req.user.role) && appt.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Can only edit non-final appointments
    if (['confirmed', 'cancelled', 'declined'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot edit an appointment with status "${appt.status}".` });
    }

    // Check daily limit on the new date
    const dateStr = new_datetime.split('T')[0];
    const count = await Appointment.countByDate(dateStr);
    if (count >= MAX_PER_DAY) {
      return res.status(409).json({
        success: false,
        message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients). Please choose another date.`,
      });
    }

    // Check time slot conflict
    const bookedSlots = await Appointment.getBookedSlots(dateStr);
    const timeStr = `${String(newDt.getHours()).padStart(2, '0')}:${String(newDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(timeStr)) {
      return res.status(409).json({
        success: false,
        message: 'This appointment time is already taken. Please choose another available time.',
      });
    }

    const updated = await Appointment.editSchedule(appt.id, new_datetime);

    // Notify staff about the edit
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyStaff(
        'appointment',
        'Appointment Rescheduled',
        `${clientName} has rescheduled their appointment #${appt.id} to ${new Date(new_datetime).toLocaleString('en-PH')}. Please review.`,
        'intake-submissions.html'
      );
    } catch (e) { console.error('Edit notification failed:', e.message); }

    // Notify the client
    try {
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'Appointment Updated',
        `Your appointment has been rescheduled to ${new Date(new_datetime).toLocaleString('en-PH')}. It is now pending staff review.`,
        'notifications.html'
      );
    } catch (e) { console.error('Edit client notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment updated. Staff will review the new schedule.', data: updated });
  } catch (error) { next(error); }
};

module.exports = {
  getAppointments, getStatusCounts, getAppointment,
  checkConflicts, approveSchedule, proposeReschedule,
  clientConfirm, clientDecline, clientRequestChange,
  getAvailability, cancelAppointment, editAppointment,
};
