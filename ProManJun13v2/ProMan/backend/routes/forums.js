const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const { contentFilter } = require('../middleware/contentFilter');
const {
  getThreads, getPendingThreads, getFlaggedThreads, getThread,
  createThread, approveThread, rejectThread, lockThread, deleteThread,
  createReply, deleteReply,
} = require('../controllers/forumController');

router.use(authenticate);

// ── Literal paths MUST come before /:id to prevent wildcard capture ──

// Pre-submission content check (any user — does NOT expose blacklist)
router.post('/check', async (req, res, next) => {
  try {
    const profanityFilter = require('../services/profanityFilter');
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, message: 'text is required.' });

    const result = await profanityFilter.filterContent(text);

    // Sanitize — don't expose exact matched terms, only categories
    const sanitized = {
      flagged: result.flagged,
      action: result.action,
      severity: result.severity,
      categories: [...new Set(result.detections.map(d => d.category))],
      count: result.detections.length,
    };
    return res.json({ success: true, data: sanitized });
  } catch (error) { next(error); }
});

// Staff-only moderation queue (must be before /:id)
router.get('/queue/pending',  authorizeMinRole('psychometrician'), getPendingThreads);
router.get('/queue/flagged',  authorizeMinRole('psychometrician'), getFlaggedThreads);

// Replies delete (literal path before /:id)
router.delete('/replies/:id', deleteReply);

// Public (authenticated) routes
router.get('/',               getThreads);
router.post('/',              contentFilter('title', 'content'), createThread);

// Parameterised routes AFTER all literal paths
router.get('/:id',            getThread);
router.delete('/:id',         deleteThread);

// Replies (uses :id param)
router.post('/:id/replies',   contentFilter('content'), createReply);

// Staff-only moderation actions
router.put('/:id/approve',    authorizeMinRole('psychometrician'), approveThread);
router.put('/:id/reject',     authorizeMinRole('psychometrician'), rejectThread);
router.put('/:id/lock',       authorizeMinRole('psychometrician'), lockThread);

module.exports = router;
