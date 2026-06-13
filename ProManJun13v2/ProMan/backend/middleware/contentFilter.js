/**
 * Content Filter Middleware
 * ─────────────────────────────────────────────────
 * Intercepts POST/PUT requests that contain user content
 * and runs them through the profanity filter BEFORE
 * the content reaches the controller.
 *
 * Actions:
 *  - allow:  pass through normally
 *  - warn:   pass through + attach warning to response
 *  - hide:   save but set status to 'hidden'/'flagged'
 *  - review: save but set status to 'flagged' + notify staff
 */

const profanityFilter = require('../services/profanityFilter');
const notificationService = require('../services/notificationService');

/**
 * Create a content filter middleware for specific fields.
 * @param {...string} fields - Request body fields to check (e.g. 'title', 'content')
 */
function contentFilter(...fields) {
  return async (req, res, next) => {
    if (!req.body) return next();

    // Combine all specified fields into one string for analysis
    const textParts = fields
      .map(f => req.body[f])
      .filter(v => typeof v === 'string' && v.trim());

    if (textParts.length === 0) return next();

    const fullText = textParts.join(' ');

    try {
      const result = await profanityFilter.filterContent(fullText);

      // Attach filter result to request for controllers to use
      req.contentFilter = result;

      if (!result.flagged) return next();

      // Log the detection
      console.log(
        `[ContentFilter] ${result.severity} violation detected. ` +
        `Action: ${result.action}. User: ${req.user?.id || 'unknown'}. ` +
        `Terms: ${result.detections.map(d => d.term).join(', ')}`
      );

      switch (result.action) {
        case 'warn':
          // Allow through but flag it
          req.contentFilterWarning = `Your post contains language that may violate community guidelines (${result.detections[0]?.category}).`;
          return next();

        case 'hide':
          // Force the content to hidden/flagged status
          req.body._filterStatus = 'flagged';
          req.contentFilterWarning = 'Your post has been temporarily held for review due to its content.';
          return next();

        case 'review':
          // Force to flagged + notify staff
          req.body._filterStatus = 'flagged';
          req.contentFilterWarning = 'Your post has been sent for moderator review due to potentially harmful content.';

          // Notify staff asynchronously
          try {
            const categories = [...new Set(result.detections.map(d => d.category))].join(', ');
            await notificationService.notifyStaff(
              'community',
              '🚨 Harmful Content Detected',
              `A post by user #${req.user?.id || '?'} was flagged for: ${categories}. ` +
              `Detected terms: ${result.detections.map(d => d.term).join(', ')}. ` +
              `Please review in the moderation dashboard.`,
              'moderation.html'
            );
          } catch (err) {
            console.error('Failed to notify staff about profanity:', err.message);
          }
          return next();

        default:
          return next();
      }
    } catch (err) {
      // Filter failure should NOT block content submission
      console.error('[ContentFilter] Error:', err.message);
      return next();
    }
  };
}

module.exports = { contentFilter };
