const { sendContactMessage } = require('../services/emailService');
const securityEvents = require('../services/securityEvents');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Handle a public Contact Us submission by forwarding it to the clinic inbox
 * via SendGrid. No authentication required — this is the public marketing form.
 */
const submitContactMessage = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (message.length > 5000) {
      securityEvents.record({
        module: 'public_content', eventType: 'contact_form_abuse',
        userId: null, ip: req.ip,
        details: `Oversized contact submission (${message.length} chars) from ${email || 'unknown'}.`,
      });
      return res.status(400).json({ success: false, message: 'Message is too long.' });
    }

    await sendContactMessage({ name, email, subject, message });

    return res.json({ success: true, message: 'Your message has been sent. Our team will get back to you soon.' });
  } catch (err) {
    console.error('Contact form error:', err.response?.body || err.message || err);
    return res.status(500).json({ success: false, message: 'Could not send your message right now. Please try again later.' });
  }
};

module.exports = { submitContactMessage };
