const Meeting = require('../models/Meeting');
const notificationService = require('../services/notificationService');

// POST /api/meetings
const createMeeting = async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: 'Meeting title is required.' });
    }
    const meeting = await Meeting.create(req.user.id, title);

    // Notify all users about the new teleconference
    try {
      await notificationService.notifyAll(
        'teleconference',
        'New Teleconference Session',
        `A new teleconference "${title}" has been scheduled.`,
        `meetings.html`,
        req.user.id  // exclude the creator
      );
    } catch (err) {
      console.error('Failed to send meeting notifications:', err.message);
    }

    return res.status(201).json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
};

// GET /api/meetings
const getMeetings = async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const meetings = await Meeting.findAll({
      status,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    return res.status(200).json({ success: true, data: meetings });
  } catch (error) {
    next(error);
  }
};

// GET /api/meetings/:id
const getMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }
    return res.status(200).json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
};

// PUT /api/meetings/:id/end
const endMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.endMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }
    return res.status(200).json({ success: true, message: 'Meeting ended.', data: meeting });
  } catch (error) {
    next(error);
  }
};

// PUT /api/meetings/:id/consent
const updateConsent = async (req, res, next) => {
  try {
    const { recording_consent } = req.body;
    if (recording_consent === undefined) {
      return res.status(400).json({ success: false, message: 'recording_consent is required.' });
    }
    const meeting = await Meeting.updateConsent(req.params.id, recording_consent);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }
    return res.status(200).json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
};

module.exports = { createMeeting, getMeetings, getMeeting, endMeeting, updateConsent };
