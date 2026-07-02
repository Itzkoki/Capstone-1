/**
 * Article Scraper Service
 * ─────────────────────────────────────────────────
 * Fetches a webpage and extracts article content using cheerio.
 * Designed for standard blog/news sites (WordPress, Medium, etc.).
 * Will NOT work for JavaScript-rendered SPAs.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

// ── Configuration ──
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB max response
const REQUEST_TIMEOUT = 15000; // 15 seconds
const MAX_REDIRECTS = 5;

// ── SSRF protection (security) ──
// A string-based hostname blocklist is bypassable (DNS names that resolve to
// loopback, IPv6-mapped IPv4, decimal/hex encodings, link-local, etc.). Instead
// we RESOLVE the hostname and validate the actual IP the request will connect to.

/**
 * Returns true if an IP string falls in a blocked (internal) range.
 */
function isBlockedIp(ip) {
  // Normalize IPv6-mapped IPv4 (::ffff:127.0.0.1 → 127.0.0.1)
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 127) return true;                              // 127.0.0.0/8 loopback
    if (p[0] === 10) return true;                               // 10.0.0.0/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;  // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true;              // 192.168.0.0/16
    if (p[0] === 169 && p[1] === 254) return true;              // 169.254.0.0/16 (AWS metadata)
    if (p[0] === 0) return true;                                // 0.0.0.0/8
    return false;
  }
  if (net.isIPv6(ip)) {
    return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
  }
  return true; // unknown format → block to be safe
}

/**
 * Validate that a URL is safe to fetch. Resolves the hostname and checks the
 * real IP(s), so encoded/aliased representations of internal addresses cannot
 * bypass the check. Async because DNS resolution is async.
 */
async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    throw new Error('Could not resolve host.');
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error('Cannot fetch from localhost or private addresses.');
    }
  }

  return parsed;
}

/**
 * Fetch a URL with redirect support.
 */
function fetchUrl(urlString, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error('Too many redirects.'));
    }

    const parsed = new URL(urlString);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(urlString, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BPSArticleBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlString).href;
        // Re-validate the redirect target — a public URL could 302 to an
        // internal address, which the initial validation would never have seen.
        return resolve(
          validateUrl(redirectUrl).then(() => fetchUrl(redirectUrl, redirectCount + 1))
        );
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: Failed to fetch the URL.`));
      }

      const contentType = res.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return reject(new Error('URL does not point to an HTML page.'));
      }

      let data = '';
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_CONTENT_LENGTH) {
          req.destroy();
          return reject(new Error('Response too large.'));
        }
        data += chunk;
      });

      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out.'));
    });
    req.on('error', reject);
  });
}

/**
 * Extract article metadata and content from HTML.
 */
function extractArticle(html, sourceUrl) {
  const $ = cheerio.load(html);

  // Remove unwanted elements
  $('script, style, noscript, iframe, svg, nav, footer, header').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('.advertisement, .ad, .ads, .sidebar, .widget, .popup, .modal, .cookie').remove();
  $('.social-share, .share-buttons, .related-posts, .comments, .comment').remove();
  $('#sidebar, #footer, #header, #nav, #menu, #comments, #ad').remove();

  // ── Extract Title ──
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('article h1').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim().split('|')[0].split('–')[0].split('-')[0].trim() ||
    'Untitled Article';

  // ── Extract Author ──
  const author =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    $('[rel="author"]').first().text().trim() ||
    $('[class*="author-name"], [class*="byline"], .author').first().text().trim() ||
    $('[itemprop="author"]').first().text().trim() ||
    null;

  // ── Extract Publication Date ──
  const publishedDate =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    $('[itemprop="datePublished"]').first().attr('content') ||
    $('[itemprop="datePublished"]').first().text().trim() ||
    null;

  // ── Extract Featured Image ──
  const featuredImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('article img').first().attr('src') ||
    $('[class*="featured"] img, [class*="hero"] img, [class*="thumbnail"] img').first().attr('src') ||
    null;

  // Resolve relative image URL
  let resolvedImage = featuredImage;
  if (featuredImage && !featuredImage.startsWith('http')) {
    try {
      resolvedImage = new URL(featuredImage, sourceUrl).href;
    } catch { resolvedImage = null; }
  }

  // ── Extract Content ──
  // Try structured selectors first, then fall back
  const contentSelectors = [
    'article [class*="content"]',
    'article',
    '[role="main"] [class*="content"]',
    '[role="main"]',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.article-body',
    '.story-body',
    '.post-body',
    'main',
    '.content',
  ];

  let contentElement = null;
  for (const selector of contentSelectors) {
    const el = $(selector).first();
    if (el.length && el.text().trim().length > 100) {
      contentElement = el;
      break;
    }
  }

  // Fallback: largest text block
  if (!contentElement) {
    let maxLen = 0;
    $('div, section').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > maxLen) {
        maxLen = text.length;
        contentElement = $(el);
      }
    });
  }

  if (!contentElement || contentElement.text().trim().length < 50) {
    throw new Error('Could not extract meaningful article content from this URL.');
  }

  // Clean the content element
  contentElement.find('script, style, nav, footer, aside, .ad, .ads, .social-share').remove();
  contentElement.find('[class*="comment"], [class*="related"], [class*="sidebar"]').remove();
  contentElement.find('button, input, form, select, textarea').remove();

  // Build clean, readable PLAIN TEXT (not HTML). Articles are rendered as
  // escaped text in the community pages, so returning raw HTML here caused the
  // markup tags to "leak" into the published article. Extracting block-level
  // text keeps paragraph/heading/list structure without any tags.
  const cleanText = extractReadableText(contentElement, $);

  return {
    title: title.substring(0, 500),
    content: cleanText,
    contentText: cleanText,
    featuredImage: resolvedImage,
    author: author ? author.substring(0, 200) : null,
    publishedDate: publishedDate || null,
    sourceUrl: sourceUrl,
  };
}

/**
 * Convert a content element into clean, readable plain text, preserving
 * paragraph / heading / list-item breaks but stripping ALL HTML tags.
 */
function extractReadableText(contentElement, $) {
  const blocks = [];
  const seen = new Set();
  contentElement.find('p, h1, h2, h3, h4, h5, h6, li, blockquote').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) return; // skip empties + duplicates (nested wrappers)
    seen.add(text);
    blocks.push(el.name === 'li' ? `• ${text}` : text);
  });

  let text = blocks.join('\n\n');

  // Fallback: if the page lacks block elements, collapse the raw text.
  if (!text || text.trim().length < 50) {
    text = contentElement.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  return text.substring(0, 20000);
}

/**
 * Sanitize HTML: keep only safe, readable elements.
 */
function sanitizeHtml(html) {
  const $ = cheerio.load(html, { decodeEntities: true });

  // Remove all event handlers and dangerous attributes
  $('*').each((_, el) => {
    const elem = $(el);
    const attribs = el.attribs || {};
    for (const attr of Object.keys(attribs)) {
      if (attr.startsWith('on') || attr === 'style' || attr === 'class' || attr === 'id') {
        elem.removeAttr(attr);
      }
      if (attr === 'href' && attribs[attr]?.startsWith('javascript:')) {
        elem.removeAttr(attr);
      }
    }
  });

  // Only keep allowed tags
  const ALLOWED_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'strong', 'b', 'em', 'i', 'u',
    'blockquote', 'br', 'a', 'img',
    'figure', 'figcaption', 'pre', 'code',
  ]);

  $('*').each((_, el) => {
    if (el.type === 'tag' && !ALLOWED_TAGS.has(el.name)) {
      $(el).replaceWith($(el).contents());
    }
  });

  // Clean up links — keep only href
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    const attrs = Object.keys(el.attribs || {});
    attrs.forEach(a => { if (a !== 'href') $(el).removeAttr(a); });
    if (href) $(el).attr('target', '_blank').attr('rel', 'noopener noreferrer');
  });

  // Clean up images — keep only src and alt
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    const alt = $(el).attr('alt') || '';
    const attrs = Object.keys(el.attribs || {});
    attrs.forEach(a => $(el).removeAttr(a));
    if (src) $(el).attr('src', src);
    $(el).attr('alt', alt);
  });

  return $.html().trim();
}

/**
 * Main scrape function.
 * @param {string} url - The article URL to scrape
 * @returns {Promise<Object>} Extracted article data
 */
async function scrape(url) {
  // Validate (async — must be awaited so the fetch blocks on validation)
  await validateUrl(url);

  // Fetch
  const html = await fetchUrl(url);

  if (!html || html.length < 100) {
    throw new Error('The URL returned empty or insufficient content.');
  }

  // Extract
  const article = extractArticle(html, url);

  return article;
}

module.exports = { scrape, validateUrl };
