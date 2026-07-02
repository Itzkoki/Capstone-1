const Notification = require('../models/Notification');

// The recipient namespace of the CURRENT request is fixed by the token type:
// staff tokens address the `staff` id space, everyone else the client `users`
// space. All reads/mutations below are scoped to it so the caller can only ever
// touch their own notifications, never those of an id-twin in the other table.
const recipientTypeOf = (req) => (req.user && req.user.type === 'staff' ? 'staff' : 'user');

// GET /api/notifications
const getNotifications = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const rt = recipientTypeOf(req);
    const notifications = await Notification.findByUserId(req.user.id, rt, parseInt(limit), parseInt(offset));
    const unreadCount = await Notification.getUnreadCount(req.user.id, rt);

    return res.status(200).json({
      success: true,
      data: { notifications, unreadCount },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/notifications/unread-count
const getUnreadCount = async (req, res, next) => {
  try {
    const count = await Notification.getUnreadCount(req.user.id, recipientTypeOf(req));
    return res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    next(error);
  }
};

// PUT /api/notifications/:id/read
const markAsRead = async (req, res, next) => {
  try {
    const notification = await Notification.markAsRead(req.params.id, req.user.id, recipientTypeOf(req));
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    return res.status(200).json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
};

// PUT /api/notifications/:id/unread
const markAsUnread = async (req, res, next) => {
  try {
    const notification = await Notification.markAsUnread(req.params.id, req.user.id, recipientTypeOf(req));
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    return res.status(200).json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
};

// PUT /api/notifications/read-all
const markAllAsRead = async (req, res, next) => {
  try {
    await Notification.markAllAsRead(req.user.id, recipientTypeOf(req));
    return res.status(200).json({ success: true, message: 'All notifications marked as read.' });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/notifications/:id
const deleteNotification = async (req, res, next) => {
  try {
    await Notification.deleteById(req.params.id, req.user.id, recipientTypeOf(req));
    return res.status(200).json({ success: true, message: 'Notification deleted.' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getNotifications, getUnreadCount, markAsRead, markAsUnread, markAllAsRead, deleteNotification };
