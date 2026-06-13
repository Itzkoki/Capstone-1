const db = require('../config/db');

const Vote = {
  /**
   * Cast or change a vote. Uses INSERT ON CONFLICT UPDATE (upsert).
   * Returns the resulting vote row.
   */
  async upsert(userId, contentType, contentId, voteValue) {
    const result = await db.query(
      `INSERT INTO votes (user_id, content_type, content_id, vote_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, content_type, content_id)
       DO UPDATE SET vote_value = $4, created_at = NOW()
       RETURNING *`,
      [userId, contentType, contentId, voteValue]
    );
    return result.rows[0];
  },

  /**
   * Remove a vote (unvote).
   */
  async remove(userId, contentType, contentId) {
    await db.query(
      `DELETE FROM votes
       WHERE user_id = $1 AND content_type = $2 AND content_id = $3`,
      [userId, contentType, contentId]
    );
  },

  /**
   * Get the total score for a piece of content.
   */
  async getScore(contentType, contentId) {
    const result = await db.query(
      `SELECT COALESCE(SUM(vote_value), 0) AS score,
              COUNT(*) FILTER (WHERE vote_value = 1) AS upvotes,
              COUNT(*) FILTER (WHERE vote_value = -1) AS downvotes
       FROM votes
       WHERE content_type = $1 AND content_id = $2`,
      [contentType, contentId]
    );
    return result.rows[0];
  },

  /**
   * Get a specific user's vote on a piece of content.
   */
  async getUserVote(userId, contentType, contentId) {
    const result = await db.query(
      `SELECT vote_value FROM votes
       WHERE user_id = $1 AND content_type = $2 AND content_id = $3`,
      [userId, contentType, contentId]
    );
    return result.rows[0]?.vote_value || null;
  },

  /**
   * Batch: get a user's votes on multiple items of the same type.
   * Returns a map of { contentId: voteValue }.
   */
  async getUserVotes(userId, contentType, contentIds) {
    if (!contentIds.length) return {};
    const result = await db.query(
      `SELECT content_id, vote_value FROM votes
       WHERE user_id = $1 AND content_type = $2 AND content_id = ANY($3)`,
      [userId, contentType, contentIds]
    );
    const map = {};
    result.rows.forEach(r => { map[r.content_id] = r.vote_value; });
    return map;
  },

  /**
   * Right-to-be-forgotten: delete all votes by a user.
   */
  async deleteByUser(userId) {
    const result = await db.query(
      'DELETE FROM votes WHERE user_id = $1',
      [userId]
    );
    return result.rowCount;
  },
};

module.exports = Vote;
