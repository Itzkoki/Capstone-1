const db = require('../config/db');

// GET /api/community/stats — live community statistics
const getCommunityStats = async (req, res, next) => {
  try {
    // Total registered users
    const membersResult = await db.query('SELECT COUNT(*) AS count FROM users');
    const members = parseInt(membersResult.rows[0].count, 10);

    // Total approved discussions (forum threads)
    const discussionsResult = await db.query(
      "SELECT COUNT(*) AS count FROM forum_threads WHERE status = 'approved'"
    );
    const discussions = parseInt(discussionsResult.rows[0].count, 10);

    // Total approved articles
    const articlesResult = await db.query(
      "SELECT COUNT(*) AS count FROM articles WHERE status = 'approved'"
    );
    const articles = parseInt(articlesResult.rows[0].count, 10);

    // Active today (users with activity logs in the last 24 hours)
    const activeResult = await db.query(
      `SELECT COUNT(DISTINCT user_id) AS count FROM activity_logs
       WHERE created_at >= NOW() - INTERVAL '24 hours' AND user_id IS NOT NULL`
    );
    const activeToday = parseInt(activeResult.rows[0].count, 10);

    return res.json({
      success: true,
      data: { members, discussions, articles, activeToday },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getCommunityStats };
