require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes         = require('./routes/auth');
const staffAuthRoutes    = require('./routes/staffAuth');
const profileRoutes      = require('./routes/profile');
const staffRoutes        = require('./routes/staff');
const notificationRoutes = require('./routes/notifications');
const articleRoutes      = require('./routes/articles');
const meetingRoutes      = require('./routes/meetings');
const dashboardRoutes    = require('./routes/dashboard');
const systemRoutes       = require('./routes/system');
const intakeRoutes       = require('./routes/intake');
const assessmentIntakeRoutes = require('./routes/assessmentIntake');
const faqRoutes          = require('./routes/faqs');
const forumRoutes        = require('./routes/forums');
const voteRoutes         = require('./routes/votes');
const moderationRoutes_  = require('./routes/moderation');
const searchRoutes       = require('./routes/search');
const communityRoutes    = require('./routes/community');
const teleconfRoutes     = require('./routes/teleconference');
const appointmentRoutes  = require('./routes/appointments');
const reportRoutes       = require('./routes/reports');
const reportTplRoutes    = require('./routes/reportTemplates');
const landingRoutes      = require('./routes/landing');
const paymentRoutes      = require('./routes/payments');
const requestRoutes      = require('./routes/requests');

const { activityLogger } = require('./middleware/activityLogger');
const runMigrations      = require('./migrations');

const app = express();

// ── Proxy compatibility ────────────────────────────────
// Behind AWS load-balancer / reverse-proxy infrastructure, trust the first
// proxy hop so req.ip and express-rate-limit see the real client IP (from the
// X-Forwarded-For header) rather than the proxy's address.
app.set('trust proxy', 1);

// ── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(activityLogger);

// ── Serve frontend static files ───────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── Serve uploaded files (team photos, etc.) ──────────
// The database stores only the file path (e.g. /uploads/team/thumbs/x.jpg);
// the actual image lives in backend/uploads and is served from here.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Routes ────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/staff-auth',    staffAuthRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/staff',         staffRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/articles',      articleRoutes);
app.use('/api/meetings',      meetingRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/system',        systemRoutes);
app.use('/api/intake-forms',  intakeRoutes);
app.use('/api/assessment-intake-forms', assessmentIntakeRoutes);
app.use('/api/faqs',          faqRoutes);
app.use('/api/forums',        forumRoutes);
app.use('/api/votes',         voteRoutes);
app.use('/api/moderation',    moderationRoutes_);
app.use('/api/search',        searchRoutes);
app.use('/api/community',     communityRoutes);
app.use('/api/teleconference', teleconfRoutes);
app.use('/api/appointments',   appointmentRoutes);
app.use('/api/reports',         reportRoutes);
app.use('/api/report-templates', reportTplRoutes);
app.use('/api/landing',         landingRoutes);
app.use('/api/payments',        paymentRoutes);
app.use('/api/requests',        requestRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 Handler ───────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

// ── Global Error Handler ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('🔥 Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

// ── Start Server ──────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  await runMigrations();
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   Auth:          /api/auth/*`);
  console.log(`   Staff Auth:    /api/staff-auth/*`);
  console.log(`   Profile:       /api/profile/*`);
  console.log(`   Staff:         /api/staff/*`);
  console.log(`   Notifications: /api/notifications/*`);
  console.log(`   Articles:      /api/articles/*`);
  console.log(`   Meetings:      /api/meetings/*`);
  console.log(`   Dashboard:     /api/dashboard`);
  console.log(`   System:        /api/system/*`);
  console.log(`   Intake Forms:  /api/intake-forms/*`);
  console.log(`   FAQs:          /api/faqs/*`);
  console.log(`   Forums:        /api/forums/*`);
  console.log(`   Votes:         /api/votes/*`);
  console.log(`   Moderation:    /api/moderation/*`);
  console.log(`   Search:        /api/search/*`);
  console.log(`   Teleconference: /api/teleconference/*`);
  console.log(`   Appointments:   /api/appointments/*`);
  console.log(`   Reports:        /api/reports/*`);
  console.log(`   Report Tpls:    /api/report-templates/*`);
  console.log(`   Landing CMS:    /api/landing/*`);
  console.log(`   Payments:       /api/payments/*`);
});

module.exports = app;
