const ContentFlag  = require('../models/ContentFlag');
const ForumThread  = require('../models/ForumThread');
const ForumReply   = require('../models/ForumReply');
const Article      = require('../models/Article');
const ModerationKeyword = require('../models/ModerationKeyword');
const notificationService = require('../services/notificationService');
const profanityFilter = require('../services/profanityFilter');

const VALID_TYPES   = ['article', 'thread', 'reply', 'faq'];
const VALID_REASONS = ['inappropriate', 'spam', 'harassment', 'misinformation', 'crisis_content', 'other'];

// POST /api/moderation/flags â€” any user reports content
const reportContent = async (req, res, next) => {
  try {
    const { content_type, content_id, reason, details } = req.body;

    if (!VALID_TYPES.includes(content_type)) {
      return res.status(400).json({ success: false, message: 'Invalid content_type.' });
    }
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, message: `Invalid reason. Must be one of: ${VALID_REASONS.join(', ')}` });
    }
    if (!content_id) {
      return res.status(400).json({ success: false, message: 'content_id is required.' });
    }

    // Prevent duplicate flags
    const exists = await ContentFlag.existsForUser(req.user.id, content_type, content_id);
    if (exists) {
      return res.status(409).json({ success: false, message: 'You have already flagged this content.' });
    }

    const flag = await ContentFlag.create(req.user.id, content_type, content_id, reason, details);

    // Notify staff
    try {
      await notificationService.notifyStaff(
        'community',
        'Content Flagged for Review',
        `A ${content_type} has been flagged as "${reason}". Please review it in the moderation dashboard.`,
        'moderation.html'
      );
    } catch (err) { console.error('Flag notification failed:', err.message); }

    return res.status(201).json({ success: true, data: flag, message: 'Content flagged for review. Thank you.' });
  } catch (error) { next(error); }
};

// GET /api/moderation/flags â€” staff: list pending flags
const getPendingFlags = async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const flags = await ContentFlag.findPending(parseInt(limit), parseInt(offset));
    return res.json({ success: true, data: flags });
  } catch (error) { next(error); }
};

// GET /api/moderation/stats â€” staff: moderation dashboard stats
const getStats = async (req, res, next) => {
  try {
    const pendingFlags    = await ContentFlag.getCountByStatus('pending');
    const flaggedThreads  = await ForumThread.getFlaggedCount();
    const pendingThreads = await ForumThread.getPendingCount();
    const pendingArticles = await Article.getPendingCount
      ? await Article.getPendingCount()
      : 0;
    const keywordCount = await ModerationKeyword.getCount();

    return res.json({
      success: true,
      data: {
        pendingFlags,
        flaggedThreads,
        totalFlags: pendingFlags + flaggedThreads,
        pendingThreads,
        pendingArticles,
        keywordCount,
      },
    });
  } catch (error) { next(error); }
};

// PUT /api/moderation/flags/:id â€” staff reviews a flag
const reviewFlag = async (req, res, next) => {
  try {
    const { status, review_note } = req.body;
    if (!['reviewed', 'dismissed', 'actioned'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be reviewed, dismissed, or actioned.' });
    }

    const flag = await ContentFlag.findById(req.params.id);
    if (!flag) return res.status(404).json({ success: false, message: 'Flag not found.' });

    // If actioned, hide/remove the flagged content
    if (status === 'actioned') {
      try {
        if (flag.content_type === 'thread') {
          await ForumThread.updateStatus(flag.content_id, 'rejected');
        } else if (flag.content_type === 'reply') {
          await ForumReply.updateStatus(flag.content_id, 'hidden');
        } else if (flag.content_type === 'article') {
          await Article.updateStatus(flag.content_id, 'rejected');
        }
      } catch (err) { console.error('Failed to action flagged content:', err.message); }
    }

    const updated = await ContentFlag.review(req.params.id, req.user.id, status, review_note);
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// â”€â”€ KEYWORD MANAGEMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VALID_CATEGORIES = [
  'profanity', 'racist_slur', 'homophobic_slur', 'transphobic_slur',
  'ableist_slur', 'sexist', 'threat', 'bullying', 'harassment', 'spam', 'other',
];
const VALID_SEVERITIES = ['mild', 'moderate', 'severe'];

// GET /api/moderation/keywords â€” list all active keywords
const getKeywords = async (req, res, next) => {
  try {
    const { language, category } = req.query;
    const keywords = await ModerationKeyword.findAll(language || null, category || null);
    return res.json({ success: true, data: keywords });
  } catch (error) { next(error); }
};

// POST /api/moderation/keywords â€” add a keyword
const addKeyword = async (req, res, next) => {
  try {
    const { word, category, severity, language } = req.body;
    if (!word || !category || !severity) {
      return res.status(400).json({ success: false, message: 'word, category, and severity are required.' });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, message: 'Severity must be mild, moderate, or severe.' });
    }

    const kw = await ModerationKeyword.create(word, category, severity, language || 'en', req.user.id);
    profanityFilter.invalidateCache();
    return res.status(201).json({ success: true, data: kw });
  } catch (error) { next(error); }
};

// DELETE /api/moderation/keywords/:id â€” remove a keyword
const removeKeyword = async (req, res, next) => {
  try {
    const kw = await ModerationKeyword.findById(req.params.id);
    if (!kw) return res.status(404).json({ success: false, message: 'Keyword not found.' });

    await ModerationKeyword.deactivate(req.params.id);
    profanityFilter.invalidateCache();
    return res.json({ success: true, message: 'Keyword removed.' });
  } catch (error) { next(error); }
};

// POST /api/moderation/keywords/test â€” test a string against the filter
const testFilter = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, message: 'text is required.' });
    const result = await profanityFilter.filterContent(text);
    return res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

// POST /api/moderation/keywords/seed â€” seed default keywords
const seedKeywords = async (req, res, next) => {
  try {
    const defaults = [
      // English profanity
      { word: 'fuck', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'shit', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'bitch', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'asshole', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'bastard', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'dick', category: 'profanity', severity: 'moderate', language: 'en' },
      { word: 'cunt', category: 'profanity', severity: 'severe', language: 'en' },
      { word: 'whore', category: 'sexist', severity: 'moderate', language: 'en' },
      { word: 'slut', category: 'sexist', severity: 'moderate', language: 'en' },
      // English slurs
      { word: 'nigger', category: 'racist_slur', severity: 'severe', language: 'en' },
      { word: 'nigga', category: 'racist_slur', severity: 'severe', language: 'en' },
      { word: 'faggot', category: 'homophobic_slur', severity: 'severe', language: 'en' },
      { word: 'retard', category: 'ableist_slur', severity: 'severe', language: 'en' },
      { word: 'tranny', category: 'transphobic_slur', severity: 'severe', language: 'en' },
      // Filipino profanity
      { word: 'putangina', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'puta', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'gago', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'bobo', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'tanga', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'ulol', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'tarantado', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'lintik', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'leche', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'pakyu', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'punyeta', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'tangina', category: 'profanity', severity: 'severe', language: 'tl' },
      { word: 'hayop', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'kupal', category: 'profanity', severity: 'moderate', language: 'tl' },
      { word: 'bakla', category: 'homophobic_slur', severity: 'moderate', language: 'tl' },
      { word: 'bayot', category: 'homophobic_slur', severity: 'moderate', language: 'tl' },
      { word: 'peste', category: 'bullying', severity: 'mild', language: 'tl' },
      { word: 'hampas lupa', category: 'bullying', severity: 'moderate', language: 'tl' },
      { word: 'engot', category: 'bullying', severity: 'moderate', language: 'tl' },
    ];

    const count = await ModerationKeyword.bulkCreate(defaults, req.user.id);
    profanityFilter.invalidateCache();
    return res.json({ success: true, message: `Seeded ${count} keywords.` });
  } catch (error) { next(error); }
};

module.exports = {
  reportContent, getPendingFlags, getStats, reviewFlag,
  getKeywords, addKeyword, removeKeyword, testFilter, seedKeywords,
};

