require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes         = require('./routes/auth');
const profileRoutes      = require('./routes/profile');
const staffRoutes        = require('./routes/staff');
const notificationRoutes = require('./routes/notifications');
const articleRoutes      = require('./routes/articles');
const meetingRoutes      = require('./routes/meetings');
const dashboardRoutes    = require('./routes/dashboard');
const systemRoutes       = require('./routes/system');
const intakeRoutes       = require('./routes/intake');
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

const { activityLogger } = require('./middleware/activityLogger');
const runMigrations      = require('./migrations');

const app = express();

// ── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(activityLogger);

// ── Serve frontend static files ───────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── Routes ────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/staff',         staffRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/articles',      articleRoutes);
app.use('/api/meetings',      meetingRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/system',        systemRoutes);
app.use('/api/intake-forms',  intakeRoutes);
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
});

module.exports = app;
