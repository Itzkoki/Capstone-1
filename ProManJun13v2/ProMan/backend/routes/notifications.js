const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { getNotifications, getUnreadCount, markAsRead, markAllAsRead, deleteNotification } = require('../controllers/notificationController');

router.use(authenticate);

router.get('/',               getNotifications);
router.get('/unread-count',   getUnreadCount);
router.put('/read-all',       markAllAsRead);
router.put('/:id/read',       markAsRead);
router.delete('/:id',         deleteNotification);

module.exports = router;
