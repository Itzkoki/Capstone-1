const Vote = require('../models/Vote');

const VALID_TYPES = ['article', 'faq', 'thread', 'reply'];

// POST /api/votes — cast or change vote
const castVote = async (req, res, next) => {
  try {
    const { content_type, content_id, vote_value } = req.body;

    if (!VALID_TYPES.includes(content_type)) {
      return res.status(400).json({ success: false, message: `Invalid content_type. Must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!content_id || !Number.isInteger(content_id)) {
      return res.status(400).json({ success: false, message: 'content_id is required and must be an integer.' });
    }
    if (![1, -1].includes(vote_value)) {
      return res.status(400).json({ success: false, message: 'vote_value must be 1 (upvote) or -1 (downvote).' });
    }

    const vote = await Vote.upsert(req.user.id, content_type, content_id, vote_value);
    const score = await Vote.getScore(content_type, content_id);

    return res.json({ success: true, data: { vote, score } });
  } catch (error) { next(error); }
};

// DELETE /api/votes/:contentType/:contentId — remove vote
const removeVote = async (req, res, next) => {
  try {
    const { contentType, contentId } = req.params;
    if (!VALID_TYPES.includes(contentType)) {
      return res.status(400).json({ success: false, message: 'Invalid content type.' });
    }

    await Vote.remove(req.user.id, contentType, parseInt(contentId));
    const score = await Vote.getScore(contentType, parseInt(contentId));

    return res.json({ success: true, data: { score } });
  } catch (error) { next(error); }
};

// GET /api/votes/:contentType/:contentId — get score + user's vote
const getVote = async (req, res, next) => {
  try {
    const { contentType, contentId } = req.params;
    if (!VALID_TYPES.includes(contentType)) {
      return res.status(400).json({ success: false, message: 'Invalid content type.' });
    }

    const cid = parseInt(contentId);
    const score = await Vote.getScore(contentType, cid);
    const userVote = await Vote.getUserVote(req.user.id, contentType, cid);

    return res.json({ success: true, data: { ...score, user_vote: userVote } });
  } catch (error) { next(error); }
};

// POST /api/votes/batch — get user's votes for multiple items
const batchGetVotes = async (req, res, next) => {
  try {
    const { content_type, content_ids } = req.body;
    if (!VALID_TYPES.includes(content_type) || !Array.isArray(content_ids)) {
      return res.status(400).json({ success: false, message: 'content_type and content_ids[] required.' });
    }

    const votes = await Vote.getUserVotes(req.user.id, content_type, content_ids);
    return res.json({ success: true, data: votes });
  } catch (error) { next(error); }
};

module.exports = { castVote, removeVote, getVote, batchGetVotes };
