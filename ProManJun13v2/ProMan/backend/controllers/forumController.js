const ForumThread = require('../models/ForumThread');
const ForumReply  = require('../models/ForumReply');
const User        = require('../models/User');
const ContentFlag = require('../models/ContentFlag');
const notificationService = require('../services/notificationService');
const crisisDetection     = require('../services/crisisDetection');
const securityEvents      = require('../services/securityEvents');
const contentAnalyzer     = require('../services/communityContentAnalyzer');

// Run the automated analyzer over new community content and, if it matches any
// flag category, open a Community incident in the Action Center carrying the
// detected category/categories, severity, and the exact triggering cues.
function autoFlag(text, contentType, contentId, req) {
  try {
    const result = contentAnalyzer.analyze(text);
    if (!result.flagged) return null;
    const { eventType, severity } = contentAnalyzer.toIncident(result);
    securityEvents.record({
      module: 'community', eventType,
      userId: req.user.id, subjectKind: req.user.type === 'staff' ? 'staff' : 'user', ip: req.ip,
      targetType: contentType, targetId: contentId, severityOverride: severity,
      details: contentAnalyzer.describe(result, contentType, contentId, text),
    });
    return result;
  } catch (e) { console.error('autoFlag failed:', e.message); return null; }
}

// ── Helper: check if user is staff ──
const isStaff = (role) => role && role !== 'client';

// ── Helper: strip anonymous author info for non-staff ──
// Preserves author_id when the requesting user IS the author (so they can delete their own anonymous content)
function sanitizeForClient(item, userRole, requestingUserId) {
  if (item.is_anonymous && !isStaff(userRole)) {
    const { author_name, ...safe } = item;
    // Only strip author_id if the requesting user is NOT the author
    if (safe.author_id !== requestingUserId) {
      delete safe.author_id;
    }
    return { ...safe, author_name: 'Anonymous' };
  }
  return item;
}

// GET /api/forums — approved threads
const getThreads = async (req, res, next) => {
  try {
    const { category, limit = 20, offset = 0 } = req.query;
    const threads = await ForumThread.findApproved(category || null, parseInt(limit), parseInt(offset));
    const data = threads.map(t => sanitizeForClient(t, req.user.role, req.user.id));
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// GET /api/forums/pending — staff moderation queue
const getPendingThreads = async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const threads = await ForumThread.findPending(parseInt(limit), parseInt(offset));
    return res.json({ success: true, data: threads });
  } catch (error) { next(error); }
};

// GET /api/forums/queue/flagged — staff: flagged/crisis threads
const getFlaggedThreads = async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const threads = await ForumThread.findFlagged(parseInt(limit), parseInt(offset));
    return res.json({ success: true, data: threads });
  } catch (error) { next(error); }
};

// GET /api/forums/:id — thread detail with replies
const getThread = async (req, res, next) => {
  try {
    const thread = await ForumThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });

    const replies = isStaff(req.user.role)
      ? await ForumReply.findByThreadForStaff(req.params.id)
      : await ForumReply.findByThread(req.params.id);

    const safeThread = sanitizeForClient(thread, req.user.role, req.user.id);
    const safeReplies = replies.map(r => sanitizeForClient(r, req.user.role, req.user.id));

    // Staff/CD see which specific post or comment has been flagged, with the
    // report reason/message, surfaced inline in the forum.
    if (isStaff(req.user.role)) {
      safeThread.flags = await ContentFlag.findPendingByContent('thread', thread.id);
      await Promise.all(
        safeReplies.map(async (r) => { r.flags = await ContentFlag.findPendingByContent('reply', r.id); })
      );
    }

    return res.json({ success: true, data: { ...safeThread, replies: safeReplies } });
  } catch (error) { next(error); }
};

// POST /api/forums — create thread
const createThread = async (req, res, next) => {
  try {
    const { title, content, category, tags, is_anonymous } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, message: 'Title and content are required.' });
    }

    // Crisis detection
    const crisisCheck = crisisDetection.checkContent(title + ' ' + content);

    // Determine status: profanity filter > crisis > role-based default
    let status;
    if (req.body._filterStatus) {
      status = req.body._filterStatus; // Set by contentFilter middleware
    } else if (crisisCheck.isCrisis) {
      status = 'flagged';
    } else {
      status = isStaff(req.user.role) ? 'approved' : 'pending';
    }

    const thread = await ForumThread.create(
      req.user.id, title, content, category, tags, is_anonymous || false, status, req.user.role || null
    );

    // Automated Action-Center flag detection (category + severity + cues).
    autoFlag(`${title}\n${content}`, 'thread', thread.id, req);

    // Notifications
    if (crisisCheck.isCrisis) {
      const author = await User.findById(req.user.id);
      const authorName = author ? author.full_name : 'A user';
      try {
        await notificationService.notifyStaff(
          'community',
          '⚠️ Crisis Content Detected',
          `${authorName} posted content that may indicate a crisis (${crisisCheck.matchedLabels.join(', ')}). Thread: "${title}". Please review immediately.`,
          'moderation.html'
        );
      } catch (err) { console.error('Crisis notification failed:', err.message); }
    } else if (!isStaff(req.user.role)) {
      try {
        const author = await User.findById(req.user.id);
        const authorName = author ? author.full_name : 'A client';
        await notificationService.notifyStaff(
          'community',
          'New Discussion Awaiting Review',
          `${authorName} submitted a new discussion: "${title}". Please review and approve or reject it.`,
          'moderation.html'
        );
      } catch (err) { console.error('Thread review notification failed:', err.message); }
    }

    const response = { success: true, data: thread };
    if (crisisCheck.isCrisis) {
      response.crisis_resources = crisisDetection.CRISIS_RESOURCES;
    }
    if (req.contentFilterWarning) {
      response.filter_warning = req.contentFilterWarning;
    }
    if (req.contentFilter?.flagged) {
      response.filter_result = {
        severity: req.contentFilter.severity,
        action: req.contentFilter.action,
        categories: [...new Set(req.contentFilter.detections.map(d => d.category))],
      };
    }
    return res.status(201).json(response);
  } catch (error) { next(error); }
};

// PUT /api/forums/:id/approve
const approveThread = async (req, res, next) => {
  try {
    const thread = await ForumThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });

    const updated = await ForumThread.updateStatus(req.params.id, 'approved');

    if (thread.author_id) {
      try {
        await notificationService.notifyUser(
          thread.author_id, 'community', 'Your Discussion Has Been Approved',
          `Your discussion "${thread.title}" is now visible to the community.`,
          `community.html?tab=discussion&thread=${thread.id}`
        );
      } catch (err) { console.error('Approval notification failed:', err.message); }
    }
    return res.json({ success: true, message: 'Thread approved.', data: updated });
  } catch (error) { next(error); }
};

// PUT /api/forums/:id/reject
const rejectThread = async (req, res, next) => {
  try {
    const thread = await ForumThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });

    const updated = await ForumThread.updateStatus(req.params.id, 'rejected');

    if (thread.author_id) {
      try {
        await notificationService.notifyUser(
          thread.author_id, 'community', 'Your Discussion Was Not Approved',
          `Your discussion "${thread.title}" was not approved. Please review community guidelines.`,
          'community.html'
        );
      } catch (err) { console.error('Rejection notification failed:', err.message); }
    }
    return res.json({ success: true, message: 'Thread rejected.', data: updated });
  } catch (error) { next(error); }
};

// PUT /api/forums/:id/lock
const lockThread = async (req, res, next) => {
  try {
    const updated = await ForumThread.updateStatus(req.params.id, 'locked');
    if (!updated) return res.status(404).json({ success: false, message: 'Thread not found.' });
    return res.json({ success: true, message: 'Thread locked.', data: updated });
  } catch (error) { next(error); }
};

// DELETE /api/forums/:id — owner or staff
const deleteThread = async (req, res, next) => {
  try {
    const thread = await ForumThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });

    if (req.user.role === 'client' && thread.author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only delete your own threads.' });
    }

    await ForumThread.deleteById(req.params.id);
    return res.json({ success: true, message: 'Thread deleted.' });
  } catch (error) { next(error); }
};

// POST /api/forums/:id/replies — add reply
const createReply = async (req, res, next) => {
  try {
    const { content, parent_id, is_anonymous } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content is required.' });

    const thread = await ForumThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });
    if (thread.status === 'locked') {
      return res.status(403).json({ success: false, message: 'This thread is locked.' });
    }

    // Crisis detection on reply content
    const crisisCheck = crisisDetection.checkContent(content);

    const reply = await ForumReply.create(
      req.params.id, parent_id, req.user.id, content, is_anonymous || false, req.user.role || null
    );
    await ForumThread.incrementReplyCount(req.params.id);

    // Automated Action-Center flag detection (category + severity + cues).
    autoFlag(content, 'reply', reply.id, req);

    // If crisis content, flag and notify staff
    if (crisisCheck.isCrisis) {
      await ForumReply.updateStatus(reply.id, 'flagged');
      try {
        const author = await User.findById(req.user.id);
        await notificationService.notifyStaff(
          'community', '⚠️ Crisis Content in Reply',
          `${author?.full_name || 'A user'} posted a reply with crisis indicators (${crisisCheck.matchedLabels.join(', ')}) in thread "${thread.title}".`,
          'moderation.html'
        );
      } catch (err) { console.error('Crisis reply notification failed:', err.message); }
    }

    // Notify thread author of new reply (if not replying to own thread)
    if (thread.author_id && thread.author_id !== req.user.id) {
      try {
        await notificationService.notifyUser(
          thread.author_id, 'community', 'New Reply on Your Discussion',
          `Someone replied to your discussion "${thread.title}".`,
          `community.html?tab=discussion&thread=${thread.id}`
        );
      } catch (err) { console.error('Reply notification failed:', err.message); }
    }

    const response = { success: true, data: reply };
    if (crisisCheck.isCrisis) {
      response.crisis_resources = crisisDetection.CRISIS_RESOURCES;
    }
    return res.status(201).json(response);
  } catch (error) { next(error); }
};

// DELETE /api/forums/replies/:id — owner or staff
const deleteReply = async (req, res, next) => {
  try {
    const reply = await ForumReply.findById(req.params.id);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found.' });

    if (req.user.role === 'client' && reply.author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only delete your own replies.' });
    }

    const deleted = await ForumReply.deleteById(req.params.id);
    if (deleted?.thread_id) await ForumThread.decrementReplyCount(deleted.thread_id);

    return res.json({ success: true, message: 'Reply deleted.' });
  } catch (error) { next(error); }
};

module.exports = {
  getThreads, getPendingThreads, getFlaggedThreads, getThread,
  createThread, approveThread, rejectThread, lockThread, deleteThread,
  createReply, deleteReply,
};
