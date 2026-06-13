const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { castVote, removeVote, getVote, batchGetVotes } = require('../controllers/voteController');

router.use(authenticate);

router.post('/',                          castVote);
router.post('/batch',                     batchGetVotes);
router.get('/:contentType/:contentId',    getVote);
router.delete('/:contentType/:contentId', removeVote);

module.exports = router;
