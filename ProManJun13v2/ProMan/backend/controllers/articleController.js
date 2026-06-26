const Article = require('../models/Article');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const articleScraper = require('../services/articleScraper');
const ActivityLog = require('../models/ActivityLog');

/**
 * Normalize article content to clean, readable paragraphs.
 * Articles imported via link (and rendered as escaped text) can carry raw
 * markup, HTML entities, and runs of whitespace/tabs/newlines that "leak" into
 * the page as code-like noise. This strips any stray tags, decodes common
 * entities, and collapses whitespace so only words/paragraphs remain.
 */
function cleanArticleContent(raw) {
  if (raw == null) return raw;
  let t = String(raw);
  // Strip any stray HTML tags.
  t = t.replace(/<[^>]+>/g, ' ');
  // Decode the most common HTML entities.
  t = t.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;|&apos;/gi, "'")
       .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // Normalize carriage returns and tabs.
  t = t.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  // Trim each line, collapse inner double-spaces, drop blanks, rebuild as
  // clean paragraphs separated by a single blank line.
  const lines = t.split('\n').map(l => l.replace(/ {2,}/g, ' ').trim()).filter(Boolean);
  return lines.join('\n\n');
}

// Apply cleanArticleContent to one row or an array of rows (in place).
function cleanContentField(data) {
  const clean = (a) => { if (a && typeof a.content === 'string') a.content = cleanArticleContent(a.content); return a; };
  return Array.isArray(data) ? data.map(clean) : clean(data);
}

// POST /api/articles — clients: pending + notify staff. Staff: auto-approved.
const createArticle = async (req, res, next) => {
  try {
    const { title, content, category, featured_image } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, message: 'Title and content are required.' });
    }

    const isStaff = req.user.role && req.user.role !== 'client';
    // Staff may attach a category + thumbnail/featured image; client posts stay plain.
    const opts = isStaff
      ? { category: category || null, featured_image: featured_image || null }
      : {};
    const article = await Article.create(req.user.id, title, content, opts);

    if (isStaff) {
      // Auto-approve staff articles
      await Article.updateStatus(article.id, 'approved');
      article.status = 'approved';
    } else {
      // Notify staff that a client post needs review
      try {
        const author = await User.findById(req.user.id);
        const authorName = author ? author.full_name : 'A client';

        await notificationService.notifyStaff(
          'community',
          'New Post Awaiting Review',
          `${authorName} submitted a new article: "${title}". Please review and approve or reject it.`,
          'moderation.html'
        );
      } catch (err) {
        console.error('Failed to send article review notifications:', err.message);
      }
    }

    return res.status(201).json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
};

// PUT /api/articles/:id/approve — staff approves a pending article
const approveArticle = async (req, res, next) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }

    const updated = await Article.updateStatus(req.params.id, 'approved');

    // Notify the author that their post was approved
    try {
      await notificationService.notifyUser(
        article.author_id,
        'community',
        'Your Post Has Been Approved',
        `Your discussion "${article.title}" has been approved and is now visible to the community.`,
        'community.html'
      );
    } catch (err) {
      console.error('Failed to send approval notification:', err.message);
    }

    return res.status(200).json({ success: true, message: 'Article approved.', data: updated });
  } catch (error) {
    next(error);
  }
};

// PUT /api/articles/:id/reject — staff rejects a pending article
const rejectArticle = async (req, res, next) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }

    const updated = await Article.updateStatus(req.params.id, 'rejected');

    // Notify the author that their post was rejected
    try {
      await notificationService.notifyUser(
        article.author_id,
        'community',
        'Your Post Was Not Approved',
        `Your discussion "${article.title}" was not approved by the moderation team. Please review community guidelines.`,
        'community.html'
      );
    } catch (err) {
      console.error('Failed to send rejection notification:', err.message);
    }

    return res.status(200).json({ success: true, message: 'Article rejected.', data: updated });
  } catch (error) {
    next(error);
  }
};

// GET /api/articles — approved only (public feed)
const getAllArticles = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const articles = await Article.findAll(parseInt(limit), parseInt(offset));
    return res.status(200).json({ success: true, data: cleanContentField(articles) });
  } catch (error) {
    next(error);
  }
};

// GET /api/articles/pending — staff moderation queue
const getPendingArticles = async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const articles = await Article.findPending(parseInt(limit), parseInt(offset));
    return res.status(200).json({ success: true, data: cleanContentField(articles) });
  } catch (error) {
    next(error);
  }
};

// GET /api/articles/:id
const getArticle = async (req, res, next) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }
    return res.status(200).json({ success: true, data: cleanContentField(article) });
  } catch (error) {
    next(error);
  }
};

// PUT /api/articles/:id
const updateArticle = async (req, res, next) => {
  try {
    const { title, content } = req.body;
    const existing = await Article.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }

    // Only the original author may edit their own article.
    if (existing.author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only edit articles you submitted.' });
    }

    const article = await Article.update(
      req.params.id,
      title || existing.title,
      content || existing.content
    );
    return res.status(200).json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/articles/:id — clients can delete own, staff can delete any
const deleteArticle = async (req, res, next) => {
  try {
    const existing = await Article.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }

    // Clients can only delete their own articles
    if (req.user.role === 'client' && existing.author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only delete your own posts.' });
    }

    await Article.deleteById(req.params.id);
    return res.status(200).json({ success: true, message: 'Article deleted.' });
  } catch (error) {
    next(error);
  }
};

// POST /api/articles/import/preview — staff: scrape URL and return preview
const importPreview = async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: 'A valid URL is required.' });
    }

    // Validate URL format
    try {
      articleScraper.validateUrl(url.trim());
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    // Check for duplicate
    const existing = await Article.findBySourceUrl(url.trim());
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `This article has already been imported: "${existing.title}" (ID: ${existing.id})`,
        data: existing,
      });
    }

    // Scrape the URL
    const extracted = await articleScraper.scrape(url.trim());

    // Normalize the extracted body so staff review clean paragraphs (no stray
    // markup / whitespace noise) before publishing.
    if (extracted) {
      if (typeof extracted.content === 'string') extracted.content = cleanArticleContent(extracted.content);
      if (typeof extracted.contentText === 'string') extracted.contentText = cleanArticleContent(extracted.contentText);
    }

    return res.json({
      success: true,
      data: extracted,
      message: 'Article content extracted. Review and edit before publishing.',
    });
  } catch (error) {
    if (error.message.includes('Invalid URL') ||
        error.message.includes('Cannot fetch') ||
        error.message.includes('Could not extract') ||
        error.message.includes('timed out') ||
        error.message.includes('HTTP ')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// POST /api/articles/import/publish — staff: save imported article
const importPublish = async (req, res, next) => {
  try {
    const { title, content, source_url, featured_image, original_author, published_date, category } = req.body;

    if (!title || !content) {
      return res.status(400).json({ success: false, message: 'Title and content are required.' });
    }
    if (!source_url) {
      return res.status(400).json({ success: false, message: 'Source URL is required for imported articles.' });
    }

    // Check duplicate again
    const existing = await Article.findBySourceUrl(source_url.trim());
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `This article has already been imported: "${existing.title}"`,
      });
    }

    // Store clean, readable text (strip any stray markup/whitespace noise).
    const cleanedContent = cleanArticleContent(content);

    // Create article with extended fields, auto-approved for staff
    const article = await Article.create(req.user.id, title, cleanedContent, {
      category: category || 'Imported',
      source_url: source_url.trim(),
      featured_image: featured_image || null,
      original_author: original_author || null,
      published_date: published_date || null,
    });

    // Auto-approve staff imports
    await Article.updateStatus(article.id, 'approved');
    article.status = 'approved';

    // Log the import
    try {
      await ActivityLog.log(
        req.user.id,
        'ARTICLE_IMPORT',
        'articles',
        article.id,
        req.ip || 'unknown',
        { source_url: source_url.trim(), title, original_author }
      );
    } catch (err) {
      console.error('Failed to log article import:', err.message);
    }

    return res.status(201).json({
      success: true,
      data: article,
      message: 'Article imported and published successfully.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createArticle, getAllArticles, getArticle, updateArticle, deleteArticle,
  approveArticle, rejectArticle, getPendingArticles,
  importPreview, importPublish,
};
