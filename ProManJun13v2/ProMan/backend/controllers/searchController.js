const db = require('../config/db');

// GET /api/search?q=keyword&type=all|article|faq|thread
const search = async (req, res, next) => {
  try {
    const { q, type = 'all' } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters.' });
    }

    const pattern = `%${q.trim()}%`;
    const results = { articles: [], faqs: [], threads: [] };

    // Search articles
    if (type === 'all' || type === 'article') {
      const articleRes = await db.query(
        `SELECT id, title, LEFT(content, 150) AS snippet, category, created_at,
                'article' AS type
         FROM articles
         WHERE status = 'approved'
           AND (title ILIKE $1 OR content ILIKE $1)
         ORDER BY created_at DESC
         LIMIT 10`,
        [pattern]
      );
      results.articles = articleRes.rows;
    }

    // Search FAQs
    if (type === 'all' || type === 'faq') {
      const faqRes = await db.query(
        `SELECT id, question AS title, LEFT(answer, 150) AS snippet, category, created_at,
                'faq' AS type
         FROM faqs
         WHERE is_published = TRUE
           AND (question ILIKE $1 OR answer ILIKE $1)
         ORDER BY sort_order ASC, created_at DESC
         LIMIT 10`,
        [pattern]
      );
      results.faqs = faqRes.rows;
    }

    // Search forum threads
    if (type === 'all' || type === 'thread') {
      const threadRes = await db.query(
        `SELECT id, title, LEFT(content, 150) AS snippet, category, created_at,
                'thread' AS type
         FROM forum_threads
         WHERE status = 'approved'
           AND (title ILIKE $1 OR content ILIKE $1)
         ORDER BY created_at DESC
         LIMIT 10`,
        [pattern]
      );
      results.threads = threadRes.rows;
    }

    // Flatten into a single sorted list for convenience
    const combined = [
      ...results.articles,
      ...results.faqs,
      ...results.threads,
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.json({
      success: true,
      data: {
        results: combined,
        counts: {
          articles: results.articles.length,
          faqs: results.faqs.length,
          threads: results.threads.length,
          total: combined.length,
        },
      },
    });
  } catch (error) { next(error); }
};

module.exports = { search };
