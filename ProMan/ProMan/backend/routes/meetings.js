const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { createMeeting, getMeetings, getMeeting, endMeeting, updateConsent } = require('../controllers/meetingController');

router.use(authenticate);

router.post('/',             createMeeting);
router.get('/',              getMeetings);
router.get('/:id',           getMeeting);
router.put('/:id/end',       endMeeting);
router.put('/:id/consent',   updateConsent);

module.exports = router;
