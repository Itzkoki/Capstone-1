/**
 * Privacy Service — Right to Be Forgotten
 * ─────────────────────────────────────────────────
 * Anonymizes or deletes all community content for a user.
 * Posts are anonymized (author_id = NULL) rather than deleted
 * to preserve community thread continuity.
 */

const db = require('../config/db');
const ForumThread = require('../models/ForumThread');
const ForumReply = require('../models/ForumReply');
const Vote = require('../models/Vote');
const ContentFlag = require('../models/ContentFlag');

/**
 * Delete/anonymize all community content for a user.
 * @param {number} userId - The user whose data to remove
 * @param {number} requestedBy - Who requested the deletion (user themselves or admin)
 * @returns {Object} Counts of affected items
 */
async function deleteAllUserContent(userId, requestedBy) {
  const counts = {
    threads: 0,
    replies: 0,
    articles: 0,
    votes: 0,
    flags: 0,
  };

  // 1. Anonymize forum threads (set author_id = NULL, is_anonymous = TRUE)
  counts.threads = await ForumThread.anonymizeByAuthor(userId);

  // 2. Anonymize forum replies
  counts.replies = await ForumReply.anonymizeByAuthor(userId);

  // 3. Anonymize articles
  const articleResult = await db.query(
    `UPDATE articles SET author_id = NULL, updated_at = NOW()
     WHERE author_id = $1`,
    [userId]
  );
  counts.articles = articleResult.rowCount;

  // 4. Delete all votes by user
  counts.votes = await Vote.deleteByUser(userId);

  // 5. Delete all flags submitted by user
  counts.flags = await ContentFlag.deleteByUser(userId);

  // 6. Log the deletion for audit purposes
  const contentTypes = [];
  if (counts.threads > 0) contentTypes.push('threads');
  if (counts.replies > 0) contentTypes.push('replies');
  if (counts.articles > 0) contentTypes.push('articles');
  if (counts.votes > 0) contentTypes.push('votes');
  if (counts.flags > 0) contentTypes.push('flags');

  const totalItems = Object.values(counts).reduce((sum, c) => sum + c, 0);

  await db.query(
    `INSERT INTO data_deletion_log (user_id, deleted_by, content_types_deleted, item_count, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, requestedBy, contentTypes, totalItems, userId === requestedBy ? 'user_request' : 'admin_action']
  );

  return counts;
}

module.exports = { deleteAllUserContent };
